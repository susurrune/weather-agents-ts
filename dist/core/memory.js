/** Memory system: short-term context, long-term persistence, working memory. */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
// node:sqlite is a recent builtin that bundlers (Vite/esbuild used by vitest)
// don't yet recognize — a static `import` gets rewritten to a bare `sqlite`
// specifier and fails to resolve. Load it through createRequire so it's
// fetched from the real Node runtime; the class type stays a type-only import.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');
import { getLogger } from './logger.js';
import { getScorer } from './semantic.js';
const log = getLogger('memory');
// Token extraction patterns for fact-recall queries.
const ASCII_TOKEN_RE = /[A-Za-z][A-Za-z0-9_+-]+/g;
const CJK_RUN_RE = /[一-鿿]+/g;
function expandUser(p) {
    return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
/**
 * Three-layer memory for each agent with SQLite persistence.
 *
 * - Short-term: conversation context (persisted to SQLite)
 * - Working: in-memory task-scoped state (persisted)
 * - Long-term: persistent key-value storage with search
 *
 * Backed by Node's built-in synchronous `node:sqlite`. Public methods stay
 * async to mirror the Python (aiosqlite) interface the agent layer awaits;
 * DB calls are synchronous internally so there is no task-scheduling /
 * pending-flush bookkeeping the Python version needed.
 */
export class Memory {
    config;
    agentName;
    shortTerm = [];
    working = {};
    dbPath;
    db = null;
    loaded = false;
    activeSession = null;
    constructor(config, agentName) {
        this.config = config;
        this.agentName = agentName;
        // Each agent gets its own database file for full isolation:
        // ~/.weather-agents/memory/<agent>.db (from the memory.db parent dir).
        const base = expandUser(config.dbPath);
        this.dbPath = join(dirname(base), `${agentName}.db`);
    }
    async initDb() {
        if (this.db !== null)
            return;
        mkdirSync(dirname(this.dbPath), { recursive: true });
        // Windows-only: hard-killed processes can leave stale WAL/SHM that lock
        // the next startup. Best-effort removal. On POSIX, removing live WAL/SHM
        // can corrupt a concurrent writer, so this is Windows-only.
        if (process.platform === 'win32') {
            for (const suf of ['-wal', '-shm']) {
                const p = this.dbPath + suf;
                if (existsSync(p)) {
                    try {
                        rmSync(p, { force: true });
                    }
                    catch {
                        /* leave it; WAL recovery will handle it */
                    }
                }
            }
        }
        const db = new DatabaseSync(this.dbPath);
        db.exec('PRAGMA journal_mode=WAL');
        db.exec('PRAGMA busy_timeout=2000');
        db.exec('PRAGMA auto_vacuum=INCREMENTAL');
        this.db = db;
        db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        this.tryExec("ALTER TABLE memories ADD COLUMN category TEXT DEFAULT 'general'");
        this.tryExec('ALTER TABLE memories ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
        this.tryExec('DROP INDEX idx_agent_key');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_key ON memories(agent, key)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_agent_category ON memories(agent, category)');
        db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        reasoning_content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent, created_at)');
        this.tryExec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
        this.tryExec('ALTER TABLE messages ADD COLUMN reasoning_content TEXT');
        this.tryExec('ALTER TABLE messages ADD COLUMN session_id TEXT');
        db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        name TEXT,
        preview TEXT DEFAULT '',
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent, updated_at DESC)');
        db.exec(`
      CREATE TABLE IF NOT EXISTS working_data (
        agent TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agent, key)
      )
    `);
        this.loadShortTerm();
        this.loadWorking();
    }
    /** Run a statement, swallowing errors (used for idempotent migrations). */
    tryExec(sql) {
        try {
            this.db?.exec(sql);
        }
        catch {
            /* column/index already exists — fine */
        }
    }
    run(sql, ...params) {
        const stmt = this.db.prepare(sql);
        stmt.run(...params);
    }
    all(sql, ...params) {
        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }
    get(sql, ...params) {
        const stmt = this.db.prepare(sql);
        return stmt.get(...params);
    }
    loadShortTerm() {
        if (!this.db || this.loaded)
            return;
        // No session — clean slate to avoid cross-session leakage. Callers wanting
        // continuity call resumeLatestSession() explicitly.
        if (!this.activeSession) {
            this.loaded = true;
            this.pruneDanglingToolCalls();
            return;
        }
        // ORDER BY id DESC (not created_at): id is strictly monotonic even when
        // multiple inserts land in the same second.
        let rows = this.all('SELECT role, content, name, tool_call_id, tool_calls, reasoning_content, created_at ' +
            'FROM messages WHERE agent = ? AND session_id = ? ORDER BY id DESC LIMIT ?', this.agentName, this.activeSession, this.config.shortTermLimit);
        // Conversation-gap truncation: stop at the first timestamp gap larger than
        // WA_RESUME_GAP_SECONDS (4h default) so a fresh chat doesn't drag in days
        // of unrelated history.
        const gapSeconds = Number(process.env.WA_RESUME_GAP_SECONDS ?? '14400');
        rows = Memory.truncateAtTimestampGap(rows, gapSeconds);
        for (const row of [...rows].reverse()) {
            let toolCalls = null;
            if (row.tool_calls) {
                try {
                    toolCalls = JSON.parse(String(row.tool_calls));
                }
                catch {
                    toolCalls = null;
                }
            }
            this.shortTerm.push({
                role: String(row.role),
                content: String(row.content),
                name: row.name === null ? null : String(row.name),
                toolCallId: row.tool_call_id === null ? null : String(row.tool_call_id),
                toolCalls,
                reasoningContent: row.reasoning_content === null ? null : String(row.reasoning_content),
            });
        }
        this.loaded = true;
        this.pruneDanglingToolCalls();
    }
    /**
     * Keep only the contiguous newest-first tail of rows where consecutive
     * created_at values are within gapSeconds of each other.
     */
    static truncateAtTimestampGap(rows, gapSeconds) {
        if (rows.length === 0 || gapSeconds <= 0)
            return rows;
        const parseTs = (raw) => {
            if (!raw)
                return null;
            // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' (UTC).
            const ms = Date.parse(String(raw).replace(' ', 'T') + 'Z');
            return Number.isNaN(ms) ? null : ms / 1000;
        };
        const keep = [rows[0]];
        let prevTs = parseTs(rows[0].created_at);
        for (const row of rows.slice(1)) {
            const curTs = parseTs(row.created_at);
            if (prevTs !== null && curTs !== null) {
                if (Math.abs(prevTs - curTs) > gapSeconds)
                    break;
            }
            keep.push(row);
            if (curTs !== null)
                prevTs = curTs;
        }
        return keep;
    }
    /**
     * Remove orphaned tool_calls/tool message pairs from short-term memory.
     *
     * Every 'tool' message must be preceded by an 'assistant' whose tool_calls
     * contains the matching id. Position-aware: each tool message satisfies the
     * CLOSEST preceding assistant carrying its id (handles duplicate ids).
     */
    pruneDanglingToolCalls() {
        if (this.shortTerm.length === 0)
            return;
        const n = this.shortTerm.length;
        const remove = new Array(n).fill(false);
        // Pass 1: position-aware matching via a per-id stack of assistant indices.
        const waiting = new Map();
        for (let i = 0; i < n; i++) {
            const msg = this.shortTerm[i];
            if (msg.role === 'assistant' && msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    const tid = tc.id;
                    if (tid) {
                        const stack = waiting.get(tid) ?? [];
                        stack.push(i);
                        waiting.set(tid, stack);
                    }
                }
            }
            else if (msg.role === 'tool' && msg.toolCallId) {
                const tid = msg.toolCallId;
                const stack = waiting.get(tid);
                if (stack && stack.length) {
                    stack.pop(); // consumed by the closest assistant
                }
                else {
                    remove[i] = true; // orphaned tool message
                }
            }
        }
        // Any assistant indices still waiting are orphaned.
        for (const indices of waiting.values()) {
            for (const i of indices)
                remove[i] = true;
        }
        if (!remove.some((r) => r))
            return;
        const kept = this.shortTerm.filter((_, i) => !remove[i]);
        // Pass 2: drop tool messages with no preceding assistant id.
        const seen = new Set();
        const sanitized = [];
        for (const msg of kept) {
            if (msg.role === 'assistant' && msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    if (tc.id)
                        seen.add(tc.id);
                }
            }
            else if (msg.role === 'tool' && msg.toolCallId && !seen.has(msg.toolCallId)) {
                continue;
            }
            sanitized.push(msg);
        }
        this.shortTerm = sanitized;
    }
    /** Public wrapper around pruneDanglingToolCalls. */
    pruneToolMessages() {
        this.pruneDanglingToolCalls();
    }
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    // -- Short-term memory (conversation context, persisted) --
    addMessage(role, content, opts = {}) {
        const msg = {
            role,
            content,
            name: opts.name ?? null,
            toolCallId: opts.toolCallId ?? null,
            toolCalls: opts.toolCalls && opts.toolCalls.length ? opts.toolCalls : null,
            reasoningContent: opts.reasoningContent || null,
        };
        const ephemeral = Boolean(opts.ephemeral);
        this.shortTerm.push(msg);
        if (this.shortTerm.length > this.config.shortTermLimit) {
            const systemMsgs = this.shortTerm.filter((m) => m.role === 'system');
            const otherMsgs = this.shortTerm.filter((m) => m.role !== 'system');
            const keep = Math.max(0, this.config.shortTermLimit - systemMsgs.length);
            this.shortTerm = keep ? [...systemMsgs, ...otherMsgs.slice(-keep)] : systemMsgs;
            this.pruneDanglingToolCalls();
        }
        // ephemeral: orchestration sub-tasks skip persistence so task prompts don't
        // pollute the chat session history on the next resume.
        if (this.db && role !== 'system' && !ephemeral) {
            const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;
            this.persistMessage(role, content, msg.name ?? null, msg.toolCallId ?? null, toolCallsJson, msg.reasoningContent ?? null, this.activeSession);
        }
    }
    persistMessage(role, content, name, toolCallId, toolCalls, reasoningContent, sessionId) {
        if (!this.db)
            return;
        try {
            this.run('INSERT INTO messages (agent, role, content, name, tool_call_id, tool_calls, reasoning_content, session_id) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)', this.agentName, role, content, name, toolCallId, toolCalls, reasoningContent, sessionId);
            if (sessionId) {
                this.run('UPDATE sessions SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', sessionId);
            }
            // Auto-prune old messages beyond maxPersistedMessages — scoped to the
            // current session so other sessions' history isn't deleted.
            const maxPersisted = this.config.maxPersistedMessages ?? 1000;
            if (sessionId && maxPersisted > 0) {
                const row = this.get("SELECT COUNT(*) AS c FROM messages WHERE agent = ? AND session_id = ? AND role != 'system'", this.agentName, sessionId);
                const count = row ? Number(row.c) : 0;
                if (count > maxPersisted) {
                    const excess = count - maxPersisted;
                    this.run('DELETE FROM messages WHERE id IN (' +
                        "SELECT id FROM messages WHERE agent = ? AND session_id = ? AND role != 'system' " +
                        'ORDER BY id ASC LIMIT ?)', this.agentName, sessionId, excess);
                }
            }
        }
        catch (e) {
            log.warning('persist_message_failed', { agent: this.agentName, error: String(e) });
        }
    }
    getMessages() {
        this.pruneDanglingToolCalls();
        const msgs = [];
        for (const m of this.shortTerm) {
            const d = { role: m.role, content: m.content };
            if (m.name)
                d.name = m.name;
            if (m.toolCallId)
                d.tool_call_id = m.toolCallId;
            if (m.toolCalls)
                d.tool_calls = m.toolCalls;
            if (m.reasoningContent)
                d.reasoning_content = m.reasoningContent;
            msgs.push(d);
        }
        return msgs;
    }
    getContextWindowUsage() {
        let totalChars = 0;
        let cjk = 0;
        for (const m of this.shortTerm) {
            totalChars += m.content.length;
            for (const c of m.content) {
                const cp = c.codePointAt(0);
                if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f))
                    cjk += 1;
            }
        }
        const other = totalChars - cjk;
        return {
            message_count: this.shortTerm.length,
            total_chars: totalChars,
            estimated_tokens: Math.max(1, cjk * 2 + Math.floor(other / 4)),
            limit: this.config.shortTermLimit,
        };
    }
    async clearShortTerm() {
        const systemMsgs = this.shortTerm.filter((m) => m.role === 'system');
        this.shortTerm = systemMsgs;
        if (!this.db)
            return;
        if (this.activeSession !== null) {
            this.run("DELETE FROM messages WHERE agent = ? AND role != 'system' AND session_id = ?", this.agentName, this.activeSession);
            this.run('UPDATE sessions SET message_count = 0 WHERE id = ?', this.activeSession);
        }
        else {
            this.run("DELETE FROM messages WHERE agent = ? AND role != 'system' AND session_id IS NULL", this.agentName);
        }
    }
    // -- Working memory (task-scoped, persisted) --
    loadWorking() {
        if (!this.db)
            return;
        const rows = this.all('SELECT key, value FROM working_data WHERE agent = ?', this.agentName);
        for (const row of rows) {
            try {
                this.working[String(row.key)] = JSON.parse(String(row.value));
            }
            catch {
                /* skip unparseable */
            }
        }
    }
    persistWorking() {
        if (!this.db)
            return;
        try {
            this.run('DELETE FROM working_data WHERE agent = ?', this.agentName);
            for (const [key, value] of Object.entries(this.working)) {
                this.run('INSERT INTO working_data (agent, key, value) VALUES (?, ?, ?)', this.agentName, key, JSON.stringify(value));
            }
        }
        catch (e) {
            log.warning('persist_working_failed', { agent: this.agentName, error: String(e) });
        }
    }
    setWorking(key, value) {
        this.working[key] = value;
        this.persistWorking();
    }
    getWorking(key, defaultValue = null) {
        return key in this.working ? this.working[key] : defaultValue;
    }
    clearWorking() {
        this.working = {};
        this.persistWorking();
    }
    // -- Long-term memory (persistent key-value with categories) --
    async remember(key, value, category = 'general') {
        if (!this.db)
            return;
        this.run('INSERT INTO memories (agent, key, value, category) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(agent, key) DO UPDATE SET ' +
            'value = excluded.value, category = excluded.category, updated_at = CURRENT_TIMESTAMP', this.agentName, key, JSON.stringify(value), category);
    }
    async recall(opts = {}) {
        if (!this.db)
            return [];
        const { key = null, category = null, limit = 20 } = opts;
        let query = 'SELECT key, value, category FROM memories WHERE agent = ?';
        const params = [this.agentName];
        if (key) {
            query += ' AND key LIKE ?';
            params.push(`%${key}%`);
        }
        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }
        query += ' ORDER BY updated_at DESC LIMIT ?';
        params.push(limit);
        const rows = this.all(query, ...params);
        return rows.map((r) => ({
            key: String(r.key),
            value: JSON.parse(String(r.value)),
            category: String(r.category),
        }));
    }
    async forget(key) {
        if (!this.db)
            return;
        this.run('DELETE FROM memories WHERE agent = ? AND key = ?', this.agentName, key);
    }
    // -- Retrieval-injection helpers --
    /**
     * Split `query` into recall tokens. ASCII words (length >= 2) first (high
     * signal), then CJK 2-/3-grams. Unique, priority-preserving.
     */
    static tokenizeForRecall(query) {
        const out = new Map();
        const text = query || '';
        for (const m of text.matchAll(ASCII_TOKEN_RE)) {
            if (!out.has(m[0]))
                out.set(m[0], null);
        }
        for (const m of text.matchAll(CJK_RUN_RE)) {
            const run = m[0];
            for (const size of [3, 2]) {
                if (run.length < size)
                    continue;
                for (let i = 0; i <= run.length - size; i++) {
                    const gram = run.slice(i, i + size);
                    if (!out.has(gram))
                        out.set(gram, null);
                }
            }
        }
        return [...out.keys()];
    }
    /**
     * Find long-term facts whose key OR value matches tokens from `query`.
     * Two passes: fast LIKE token scan, then semantic n-gram scoring on recent
     * facts. Returns at most `limit` distinct facts by combined relevance.
     */
    async recallForInjection(query, limit = 3) {
        if (!this.db || !query)
            return [];
        const tokens = Memory.tokenizeForRecall(query).slice(0, 24);
        // Pass 1: LIKE token scan.
        const likeHits = [];
        if (tokens.length) {
            const likeClauses = tokens.map(() => 'key LIKE ? OR value LIKE ?').join(' OR ');
            const params = [this.agentName];
            for (const tok of tokens) {
                params.push(`%${tok}%`, `%${tok}%`);
            }
            params.push(limit * 2);
            const rows = this.all(`SELECT key, value, category, updated_at FROM memories ` +
                `WHERE agent = ? AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`, ...params);
            for (const r of rows) {
                let val;
                try {
                    val = JSON.parse(String(r.value));
                }
                catch {
                    val = r.value;
                }
                likeHits.push({ key: String(r.key), value: val, category: String(r.category) });
            }
        }
        // Pass 2: semantic n-gram scoring on recent facts (best-effort).
        const semanticHits = [];
        try {
            const seenKeys = new Set(likeHits.map((f) => f.key));
            const rows2 = this.all('SELECT key, value, category, updated_at FROM memories ' +
                'WHERE agent = ? ORDER BY updated_at DESC LIMIT 200', this.agentName);
            const candidates = [];
            for (const r of rows2) {
                if (seenKeys.has(String(r.key)))
                    continue;
                let val;
                try {
                    val = JSON.parse(String(r.value));
                }
                catch {
                    val = r.value;
                }
                candidates.push({ key: String(r.key), value: val, category: String(r.category) });
            }
            const scorer = getScorer();
            for (const [, c] of scorer.rank(query, candidates, {
                keyField: 'value',
                topK: limit,
                minScore: 0.03,
            })) {
                semanticHits.push({ key: c.key, value: c.value, category: c.category });
            }
        }
        catch {
            /* semantic pass is best-effort; never break recall */
        }
        // Merge: LIKE hits first (higher precision), then semantic.
        const seen = new Set();
        const merged = [];
        for (const src of [likeHits, semanticHits]) {
            for (const item of src) {
                if (seen.has(item.key))
                    continue;
                seen.add(item.key);
                merged.push({ key: item.key, value: item.value, category: item.category });
                if (merged.length >= limit)
                    return merged;
            }
        }
        return merged;
    }
    /** Render facts as a compact markdown block for prompt injection. */
    static formatFactsBlock(facts) {
        if (!facts || facts.length === 0)
            return '';
        const lines = ['## 相关记忆'];
        for (const f of facts) {
            let v = f.value;
            if (typeof v !== 'string') {
                try {
                    v = JSON.stringify(v);
                }
                catch {
                    /* leave as-is */
                }
            }
            lines.push(`- **${f.key}**: ${v}`);
        }
        return lines.join('\n');
    }
    // -- Session management --
    getActiveSession() {
        return this.activeSession;
    }
    async createSession(name = null) {
        const sessionId = randomUUID().replace(/-/g, '').slice(0, 12);
        const preview = name || '';
        if (!this.db)
            return sessionId;
        this.run('INSERT INTO sessions (id, agent, name, preview) VALUES (?, ?, ?, ?)', sessionId, this.agentName, name, preview);
        this.activeSession = sessionId;
        this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
        this.loaded = true;
        return sessionId;
    }
    async listSessions() {
        if (!this.db)
            return [];
        const rows = this.all('SELECT id, agent, name, preview, message_count, created_at, updated_at ' +
            'FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 50', this.agentName);
        return rows.map((r) => ({
            id: String(r.id),
            agent: String(r.agent),
            name: r.name === null ? null : String(r.name),
            preview: String(r.preview ?? ''),
            message_count: Number(r.message_count ?? 0),
            created_at: String(r.created_at),
            updated_at: String(r.updated_at),
        }));
    }
    async resumeLatestSession() {
        if (!this.db || this.activeSession)
            return this.activeSession;
        const row = this.get('SELECT id FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 1', this.agentName);
        if (!row)
            return null;
        this.activeSession = String(row.id);
        this.loaded = false;
        this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
        this.loadShortTerm();
        return this.activeSession;
    }
    async loadSession(sessionId) {
        if (!this.db)
            return false;
        const row = this.get('SELECT id FROM sessions WHERE id = ? AND agent = ?', sessionId, this.agentName);
        if (!row)
            return false;
        this.activeSession = sessionId;
        this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
        this.loaded = false;
        this.loadShortTerm();
        return true;
    }
    async deleteSession(sessionId) {
        if (!this.db)
            return false;
        const row = this.get('SELECT id FROM sessions WHERE id = ? AND agent = ?', sessionId, this.agentName);
        if (!row)
            return false;
        this.run('DELETE FROM messages WHERE agent = ? AND session_id = ?', this.agentName, sessionId);
        this.run('DELETE FROM sessions WHERE id = ? AND agent = ?', sessionId, this.agentName);
        if (this.activeSession === sessionId) {
            this.activeSession = null;
            this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
        }
        return true;
    }
    async updateSessionPreview() {
        if (!this.db || !this.activeSession)
            return;
        const row = this.get("SELECT content FROM messages WHERE agent = ? AND session_id = ? AND role = 'user' " +
            'ORDER BY id ASC LIMIT 1', this.agentName, this.activeSession);
        if (row) {
            const preview = String(row.content).slice(0, 80);
            this.run('UPDATE sessions SET preview = ? WHERE id = ?', preview, this.activeSession);
        }
    }
    async getMemoryStats() {
        if (!this.db)
            return { total: 0, categories: {} };
        const rows = this.all('SELECT category, COUNT(*) AS c FROM memories WHERE agent = ? GROUP BY category', this.agentName);
        const categories = {};
        for (const r of rows) {
            categories[String(r.category)] = Number(r.c);
        }
        const total = Object.values(categories).reduce((a, b) => a + b, 0);
        return { total, categories };
    }
}
