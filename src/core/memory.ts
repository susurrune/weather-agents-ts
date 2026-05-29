/** Memory system: short-term context, long-term persistence, working memory. */

import type { DatabaseSync as DatabaseSyncT, StatementSync } from 'node:sqlite';
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
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncT;
};

import type { MemoryConfig } from './config.js';
import { getLogger } from './logger.js';
import { getScorer } from './semantic.js';

const log = getLogger('memory');

// Token extraction patterns for fact-recall queries.
const ASCII_TOKEN_RE = /[A-Za-z][A-Za-z0-9_+-]+/g;
const CJK_RUN_RE = /[一-鿿]+/g;

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

function expandUser(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export interface Message {
  role: string;
  content: string;
  name?: string | null;
  toolCallId?: string | null;
  toolCalls?: Array<Record<string, any>> | null;
  reasoningContent?: string | null;
}

export interface MessageDict {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, any>>;
  reasoning_content?: string;
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
  readonly config: MemoryConfig;
  readonly agentName: string;
  shortTerm: Message[] = [];
  working: Record<string, any> = {};

  private readonly dbPath: string;
  private db: DatabaseSyncT | null = null;
  private loaded = false;
  private activeSession: string | null = null;

  constructor(config: MemoryConfig, agentName: string) {
    this.config = config;
    this.agentName = agentName;
    // Each agent gets its own database file for full isolation:
    // ~/.weather-agents/memory/<agent>.db (from the memory.db parent dir).
    const base = expandUser(config.dbPath);
    this.dbPath = join(dirname(base), `${agentName}.db`);
  }

  async initDb(): Promise<void> {
    if (this.db !== null) return;
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
          } catch {
            /* leave it; WAL recovery will handle it */
          }
        }
      }
    }

    const db: DatabaseSyncT = new DatabaseSync(this.dbPath);
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
  private tryExec(sql: string): void {
    try {
      this.db?.exec(sql);
    } catch {
      /* column/index already exists — fine */
    }
  }

  private run(sql: string, ...params: SqlValue[]): void {
    const stmt: StatementSync = this.db!.prepare(sql);
    stmt.run(...params);
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    const stmt: StatementSync = this.db!.prepare(sql);
    return stmt.all(...params) as Row[];
  }

  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    const stmt: StatementSync = this.db!.prepare(sql);
    return stmt.get(...params) as Row | undefined;
  }

  private loadShortTerm(): void {
    if (!this.db || this.loaded) return;

    // No session — clean slate to avoid cross-session leakage. Callers wanting
    // continuity call resumeLatestSession() explicitly.
    if (!this.activeSession) {
      this.loaded = true;
      this.pruneDanglingToolCalls();
      return;
    }

    // ORDER BY id DESC (not created_at): id is strictly monotonic even when
    // multiple inserts land in the same second.
    let rows = this.all(
      'SELECT role, content, name, tool_call_id, tool_calls, reasoning_content, created_at ' +
        'FROM messages WHERE agent = ? AND session_id = ? ORDER BY id DESC LIMIT ?',
      this.agentName,
      this.activeSession,
      this.config.shortTermLimit,
    );

    // Conversation-gap truncation: stop at the first timestamp gap larger than
    // WA_RESUME_GAP_SECONDS (4h default) so a fresh chat doesn't drag in days
    // of unrelated history.
    const gapSeconds = Number(process.env.WA_RESUME_GAP_SECONDS ?? '14400');
    rows = Memory.truncateAtTimestampGap(rows, gapSeconds);

    for (const row of [...rows].reverse()) {
      let toolCalls: Array<Record<string, any>> | null = null;
      if (row.tool_calls) {
        try {
          toolCalls = JSON.parse(String(row.tool_calls));
        } catch {
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
  static truncateAtTimestampGap(rows: Row[], gapSeconds: number): Row[] {
    if (rows.length === 0 || gapSeconds <= 0) return rows;

    const parseTs = (raw: SqlValue | undefined): number | null => {
      if (!raw) return null;
      // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' (UTC).
      const ms = Date.parse(String(raw).replace(' ', 'T') + 'Z');
      return Number.isNaN(ms) ? null : ms / 1000;
    };

    const keep: Row[] = [rows[0]!];
    let prevTs = parseTs(rows[0]!.created_at);
    for (const row of rows.slice(1)) {
      const curTs = parseTs(row.created_at);
      if (prevTs !== null && curTs !== null) {
        if (Math.abs(prevTs - curTs) > gapSeconds) break;
      }
      keep.push(row);
      if (curTs !== null) prevTs = curTs;
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
  pruneDanglingToolCalls(): void {
    if (this.shortTerm.length === 0) return;

    const n = this.shortTerm.length;
    const remove = new Array<boolean>(n).fill(false);

    // Pass 1: position-aware matching via a per-id stack of assistant indices.
    const waiting = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const msg = this.shortTerm[i]!;
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const tid = tc.id;
          if (tid) {
            const stack = waiting.get(tid) ?? [];
            stack.push(i);
            waiting.set(tid, stack);
          }
        }
      } else if (msg.role === 'tool' && msg.toolCallId) {
        const tid = msg.toolCallId;
        const stack = waiting.get(tid);
        if (stack && stack.length) {
          stack.pop(); // consumed by the closest assistant
        } else {
          remove[i] = true; // orphaned tool message
        }
      }
    }
    // Any assistant indices still waiting are orphaned.
    for (const indices of waiting.values()) {
      for (const i of indices) remove[i] = true;
    }

    if (!remove.some((r) => r)) return;

    const kept = this.shortTerm.filter((_, i) => !remove[i]);

    // Pass 2: drop tool messages with no preceding assistant id.
    const seen = new Set<string>();
    const sanitized: Message[] = [];
    for (const msg of kept) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.id) seen.add(tc.id);
        }
      } else if (msg.role === 'tool' && msg.toolCallId && !seen.has(msg.toolCallId)) {
        continue;
      }
      sanitized.push(msg);
    }
    this.shortTerm = sanitized;
  }

  /** Public wrapper around pruneDanglingToolCalls. */
  pruneToolMessages(): void {
    this.pruneDanglingToolCalls();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // -- Short-term memory (conversation context, persisted) --

  addMessage(
    role: string,
    content: string,
    opts: {
      name?: string | null;
      toolCallId?: string | null;
      toolCalls?: Array<Record<string, any>> | null;
      reasoningContent?: string | null;
      ephemeral?: boolean;
    } = {},
  ): void {
    const msg: Message = {
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
      this.persistMessage(
        role,
        content,
        msg.name ?? null,
        msg.toolCallId ?? null,
        toolCallsJson,
        msg.reasoningContent ?? null,
        this.activeSession,
      );
    }
  }

  private persistMessage(
    role: string,
    content: string,
    name: string | null,
    toolCallId: string | null,
    toolCalls: string | null,
    reasoningContent: string | null,
    sessionId: string | null,
  ): void {
    if (!this.db) return;
    try {
      this.run(
        'INSERT INTO messages (agent, role, content, name, tool_call_id, tool_calls, reasoning_content, session_id) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        this.agentName,
        role,
        content,
        name,
        toolCallId,
        toolCalls,
        reasoningContent,
        sessionId,
      );
      if (sessionId) {
        this.run(
          'UPDATE sessions SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          sessionId,
        );
      }
      // Auto-prune old messages beyond maxPersistedMessages — scoped to the
      // current session so other sessions' history isn't deleted.
      const maxPersisted = this.config.maxPersistedMessages ?? 1000;
      if (sessionId && maxPersisted > 0) {
        const row = this.get(
          "SELECT COUNT(*) AS c FROM messages WHERE agent = ? AND session_id = ? AND role != 'system'",
          this.agentName,
          sessionId,
        );
        const count = row ? Number(row.c) : 0;
        if (count > maxPersisted) {
          const excess = count - maxPersisted;
          this.run(
            'DELETE FROM messages WHERE id IN (' +
              "SELECT id FROM messages WHERE agent = ? AND session_id = ? AND role != 'system' " +
              'ORDER BY id ASC LIMIT ?)',
            this.agentName,
            sessionId,
            excess,
          );
        }
      }
    } catch (e) {
      log.warning('persist_message_failed', { agent: this.agentName, error: String(e) });
    }
  }

  getMessages(): MessageDict[] {
    this.pruneDanglingToolCalls();
    const msgs: MessageDict[] = [];
    for (const m of this.shortTerm) {
      const d: MessageDict = { role: m.role, content: m.content };
      if (m.name) d.name = m.name;
      if (m.toolCallId) d.tool_call_id = m.toolCallId;
      if (m.toolCalls) d.tool_calls = m.toolCalls;
      if (m.reasoningContent) d.reasoning_content = m.reasoningContent;
      msgs.push(d);
    }
    return msgs;
  }

  getContextWindowUsage(): {
    message_count: number;
    total_chars: number;
    estimated_tokens: number;
    limit: number;
  } {
    let totalChars = 0;
    let cjk = 0;
    for (const m of this.shortTerm) {
      totalChars += m.content.length;
      for (const c of m.content) {
        const cp = c.codePointAt(0)!;
        if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f)) cjk += 1;
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

  async clearShortTerm(): Promise<void> {
    const systemMsgs = this.shortTerm.filter((m) => m.role === 'system');
    this.shortTerm = systemMsgs;
    if (!this.db) return;
    if (this.activeSession !== null) {
      this.run(
        "DELETE FROM messages WHERE agent = ? AND role != 'system' AND session_id = ?",
        this.agentName,
        this.activeSession,
      );
      this.run('UPDATE sessions SET message_count = 0 WHERE id = ?', this.activeSession);
    } else {
      this.run(
        "DELETE FROM messages WHERE agent = ? AND role != 'system' AND session_id IS NULL",
        this.agentName,
      );
    }
  }

  // -- Working memory (task-scoped, persisted) --

  private loadWorking(): void {
    if (!this.db) return;
    const rows = this.all('SELECT key, value FROM working_data WHERE agent = ?', this.agentName);
    for (const row of rows) {
      try {
        this.working[String(row.key)] = JSON.parse(String(row.value));
      } catch {
        /* skip unparseable */
      }
    }
  }

  private persistWorking(): void {
    if (!this.db) return;
    try {
      this.run('DELETE FROM working_data WHERE agent = ?', this.agentName);
      for (const [key, value] of Object.entries(this.working)) {
        this.run(
          'INSERT INTO working_data (agent, key, value) VALUES (?, ?, ?)',
          this.agentName,
          key,
          JSON.stringify(value),
        );
      }
    } catch (e) {
      log.warning('persist_working_failed', { agent: this.agentName, error: String(e) });
    }
  }

  setWorking(key: string, value: any): void {
    this.working[key] = value;
    this.persistWorking();
  }

  getWorking(key: string, defaultValue: any = null): any {
    return key in this.working ? this.working[key] : defaultValue;
  }

  clearWorking(): void {
    this.working = {};
    this.persistWorking();
  }

  // -- Long-term memory (persistent key-value with categories) --

  async remember(key: string, value: any, category = 'general'): Promise<void> {
    if (!this.db) return;
    this.run(
      'INSERT INTO memories (agent, key, value, category) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(agent, key) DO UPDATE SET ' +
        'value = excluded.value, category = excluded.category, updated_at = CURRENT_TIMESTAMP',
      this.agentName,
      key,
      JSON.stringify(value),
      category,
    );
  }

  async recall(
    opts: { key?: string | null; category?: string | null; limit?: number } = {},
  ): Promise<Array<{ key: string; value: any; category: string }>> {
    if (!this.db) return [];
    const { key = null, category = null, limit = 20 } = opts;
    let query = 'SELECT key, value, category FROM memories WHERE agent = ?';
    const params: SqlValue[] = [this.agentName];
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

  async forget(key: string): Promise<void> {
    if (!this.db) return;
    this.run('DELETE FROM memories WHERE agent = ? AND key = ?', this.agentName, key);
  }

  // -- Retrieval-injection helpers --

  /**
   * Split `query` into recall tokens. ASCII words (length >= 2) first (high
   * signal), then CJK 2-/3-grams. Unique, priority-preserving.
   */
  static tokenizeForRecall(query: string): string[] {
    const out = new Map<string, null>();
    const text = query || '';
    for (const m of text.matchAll(ASCII_TOKEN_RE)) {
      if (!out.has(m[0])) out.set(m[0], null);
    }
    for (const m of text.matchAll(CJK_RUN_RE)) {
      const run = m[0];
      for (const size of [3, 2]) {
        if (run.length < size) continue;
        for (let i = 0; i <= run.length - size; i++) {
          const gram = run.slice(i, i + size);
          if (!out.has(gram)) out.set(gram, null);
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
  async recallForInjection(
    query: string,
    limit = 3,
  ): Promise<Array<{ key: string; value: any; category: string }>> {
    if (!this.db || !query) return [];
    const tokens = Memory.tokenizeForRecall(query).slice(0, 24);

    // Pass 1: LIKE token scan.
    const likeHits: Array<{ key: string; value: any; category: string }> = [];
    if (tokens.length) {
      const likeClauses = tokens.map(() => 'key LIKE ? OR value LIKE ?').join(' OR ');
      const params: SqlValue[] = [this.agentName];
      for (const tok of tokens) {
        params.push(`%${tok}%`, `%${tok}%`);
      }
      params.push(limit * 2);
      const rows = this.all(
        `SELECT key, value, category, updated_at FROM memories ` +
          `WHERE agent = ? AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`,
        ...params,
      );
      for (const r of rows) {
        let val: any;
        try {
          val = JSON.parse(String(r.value));
        } catch {
          val = r.value;
        }
        likeHits.push({ key: String(r.key), value: val, category: String(r.category) });
      }
    }

    // Pass 2: semantic n-gram scoring on recent facts (best-effort).
    const semanticHits: Array<{ key: string; value: any; category: string }> = [];
    try {
      const seenKeys = new Set(likeHits.map((f) => f.key));
      const rows2 = this.all(
        'SELECT key, value, category, updated_at FROM memories ' +
          'WHERE agent = ? ORDER BY updated_at DESC LIMIT 200',
        this.agentName,
      );
      const candidates: Array<Record<string, any>> = [];
      for (const r of rows2) {
        if (seenKeys.has(String(r.key))) continue;
        let val: any;
        try {
          val = JSON.parse(String(r.value));
        } catch {
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
    } catch {
      /* semantic pass is best-effort; never break recall */
    }

    // Merge: LIKE hits first (higher precision), then semantic.
    const seen = new Set<string>();
    const merged: Array<{ key: string; value: any; category: string }> = [];
    for (const src of [likeHits, semanticHits]) {
      for (const item of src) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        merged.push({ key: item.key, value: item.value, category: item.category });
        if (merged.length >= limit) return merged;
      }
    }
    return merged;
  }

  /** Render facts as a compact markdown block for prompt injection. */
  static formatFactsBlock(facts: Array<{ key: string; value: any }>): string {
    if (!facts || facts.length === 0) return '';
    const lines = ['## 相关记忆'];
    for (const f of facts) {
      let v = f.value;
      if (typeof v !== 'string') {
        try {
          v = JSON.stringify(v);
        } catch {
          /* leave as-is */
        }
      }
      lines.push(`- **${f.key}**: ${v}`);
    }
    return lines.join('\n');
  }

  // -- Session management --

  getActiveSession(): string | null {
    return this.activeSession;
  }

  async createSession(name: string | null = null): Promise<string> {
    const sessionId = randomUUID().replace(/-/g, '').slice(0, 12);
    const preview = name || '';
    if (!this.db) return sessionId;
    this.run(
      'INSERT INTO sessions (id, agent, name, preview) VALUES (?, ?, ?, ?)',
      sessionId,
      this.agentName,
      name,
      preview,
    );
    this.activeSession = sessionId;
    this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
    this.loaded = true;
    return sessionId;
  }

  async listSessions(): Promise<
    Array<{
      id: string;
      agent: string;
      name: string | null;
      preview: string;
      message_count: number;
      created_at: string;
      updated_at: string;
    }>
  > {
    if (!this.db) return [];
    const rows = this.all(
      'SELECT id, agent, name, preview, message_count, created_at, updated_at ' +
        'FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 50',
      this.agentName,
    );
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

  async resumeLatestSession(): Promise<string | null> {
    if (!this.db || this.activeSession) return this.activeSession;
    const row = this.get(
      'SELECT id FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 1',
      this.agentName,
    );
    if (!row) return null;
    this.activeSession = String(row.id);
    this.loaded = false;
    this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
    this.loadShortTerm();
    return this.activeSession;
  }

  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.db) return false;
    const row = this.get(
      'SELECT id FROM sessions WHERE id = ? AND agent = ?',
      sessionId,
      this.agentName,
    );
    if (!row) return false;
    this.activeSession = sessionId;
    this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
    this.loaded = false;
    this.loadShortTerm();
    return true;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.db) return false;
    const row = this.get(
      'SELECT id FROM sessions WHERE id = ? AND agent = ?',
      sessionId,
      this.agentName,
    );
    if (!row) return false;
    this.run('DELETE FROM messages WHERE agent = ? AND session_id = ?', this.agentName, sessionId);
    this.run('DELETE FROM sessions WHERE id = ? AND agent = ?', sessionId, this.agentName);
    if (this.activeSession === sessionId) {
      this.activeSession = null;
      this.shortTerm = this.shortTerm.filter((m) => m.role === 'system');
    }
    return true;
  }

  async updateSessionPreview(): Promise<void> {
    if (!this.db || !this.activeSession) return;
    const row = this.get(
      "SELECT content FROM messages WHERE agent = ? AND session_id = ? AND role = 'user' " +
        'ORDER BY id ASC LIMIT 1',
      this.agentName,
      this.activeSession,
    );
    if (row) {
      const preview = String(row.content).slice(0, 80);
      this.run('UPDATE sessions SET preview = ? WHERE id = ?', preview, this.activeSession);
    }
  }

  async getMemoryStats(): Promise<{ total: number; categories: Record<string, number> }> {
    if (!this.db) return { total: 0, categories: {} };
    const rows = this.all(
      'SELECT category, COUNT(*) AS c FROM memories WHERE agent = ? GROUP BY category',
      this.agentName,
    );
    const categories: Record<string, number> = {};
    for (const r of rows) {
      categories[String(r.category)] = Number(r.c);
    }
    const total = Object.values(categories).reduce((a, b) => a + b, 0);
    return { total, categories };
  }
}
