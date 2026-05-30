/**
 * Base agent class for all Weather Agents. Central orchestrator: tool-call
 * loop, skill activation, memory recall injection, feature detection,
 * inter-agent messaging, compaction, fact extraction. (2675-line Python, 1:1 port.)
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { EventType, makeEvent } from './bus.js';
import { TASK_DONE_SENTINEL } from './constants.js';
import { getModelContextWindow } from './config.js';
import { getLogger } from './logger.js';
import { Memory } from './memory.js';
import { SkillRegistry } from './skill.js';
import { Tool } from './tool.js';
import { Mutex } from './util.js';
import { initWorkspace, resolveWorkspacePath } from './workspace.js';
import { selectRelevantTools } from './toolRouter.js';
import { ratio, getCloseMatches } from './difflib.js';
const log = getLogger('agent');
// ── Enums ────────────────────────────────────────────────────────────────────
export var AgentState;
(function (AgentState) {
    AgentState["IDLE"] = "idle";
    AgentState["THINKING"] = "thinking";
    AgentState["ACTING"] = "acting";
    AgentState["WAITING"] = "waiting";
    AgentState["ERROR"] = "error";
})(AgentState || (AgentState = {}));
export var TaskState;
(function (TaskState) {
    TaskState["PENDING"] = "pending";
    TaskState["RUNNING"] = "running";
    TaskState["COMPLETED"] = "completed";
    TaskState["FAILED"] = "failed";
    TaskState["SKIPPED"] = "skipped";
})(TaskState || (TaskState = {}));
const VALID_TRANSITIONS = {
    [TaskState.PENDING]: new Set([TaskState.RUNNING, TaskState.SKIPPED, TaskState.FAILED]),
    [TaskState.RUNNING]: new Set([TaskState.RUNNING, TaskState.COMPLETED, TaskState.FAILED]),
    [TaskState.FAILED]: new Set([TaskState.RUNNING, TaskState.SKIPPED]),
    [TaskState.COMPLETED]: new Set(),
    [TaskState.SKIPPED]: new Set(),
};
export class Task {
    id;
    description;
    assignedTo;
    parentId;
    dependsOn;
    status;
    priority;
    result;
    metadata;
    constructor(init) {
        this.id = init.id;
        this.description = init.description;
        this.assignedTo = init.assignedTo ?? null;
        this.parentId = init.parentId ?? null;
        this.dependsOn = init.dependsOn ?? [];
        this.status = init.status ?? TaskState.PENDING;
        this.priority = init.priority ?? 0;
        this.result = init.result ?? null;
        this.metadata = init.metadata ?? {};
    }
    transitionTo(newState) {
        const allowed = VALID_TRANSITIONS[this.status];
        if (!allowed.has(newState)) {
            throw new Error(`Invalid task state transition: ${this.status} → ${newState}`);
        }
        this.status = newState;
    }
    get allDeps() {
        const deps = [...this.dependsOn];
        if (this.parentId && !deps.includes(this.parentId))
            deps.push(this.parentId);
        return deps;
    }
}
// ── BaseAgent ───────────────────────────────────────────────────────────────
// Time-tag cache (shared across all instances, 30s TTL).
let _timeTag = null;
let _timeTagTs = 0;
// ── Tool call helpers (pre-compiled regexes + labels) ──────────────────────
const RE_FENCED_JSON_ARRAY = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/;
const RE_JSON_ARRAY = /\[[\s\S]*?\]/;
const RE_OBJ_OR_ARRAY = /(\{.*\}|\[.*\])/s;
const RE_KV_DETECT = /\b\w[\w\d]*\s*=/;
const RE_KV_PAIRS = /(\w[\w\d]*)\s*=\s*("[^"]*"|'[^']*'|[\w\d_.+-]+)/g;
const RE_NONE_LITERAL = /:\s*None\s*([,}])/g;
const RE_TRUE_LITERAL = /:\s*True\s*([,}])/g;
const RE_FALSE_LITERAL = /:\s*False\s*([,}])/g;
const RE_PY_NONE = /\bNone\b/g;
const RE_PY_TRUE = /\bTrue\b/g;
const RE_PY_FALSE = /\bFalse\b/g;
const RE_UNQUOTED_KEY = /([{,]\s*)(\w[\w\d]*)(\s*:)/g;
const RE_TRAILING_COMMA = /,\s*([}\]])/g;
const RE_UNQUOTED_STRING = /(:\s*)([a-zA-Z_.][a-zA-Z0-9_ ./\\@.\-+#~$]*?)(\s*[,}\]])/g;
const TOOL_LABELS = {
    read_file: 'Reading {path}',
    write_file: 'Writing {path}',
    edit_file: 'Editing {path}',
    list_directory: 'Listing {path}',
    file_search: 'Searching {directory}/{pattern}',
    code_search: "Searching for '{query}'",
    grep: "Grepping '{pattern}'",
    shell_exec: 'Running: {command}',
    http_get: 'GET {url}',
    http_post: 'POST {url}',
    web_search: 'Searching: {query}',
    move_file: 'Moving {src}',
    copy_file: 'Copying {src}',
    delete_file: 'Deleting {path}',
    get_cwd: 'Getting working directory',
    tree: 'Tree {directory}',
    lint_file: 'Linting {path}',
    scan_deps: 'Scanning {directory}',
    fetch_page: 'Fetching {url}',
    delegate_to: 'Delegating to {agent}: {task}',
    use_skill: 'Activating {name}',
    list_skills: 'Listing available skills',
    git_status: 'Git status',
    git_diff: 'Git diff',
    git_log: 'Git log',
    git_add: 'Git add {files}',
    git_commit: 'Git commit',
    git_checkout: 'Git checkout {branch}',
};
// Failure markers for stuck-loop detection.
const TOOL_FAILURE_MARKERS = [
    'no results found',
    'no matches for',
    'file not found',
    'directory not found',
    'permission denied',
    'status: 4',
    'status: 5',
    'request timed out',
    'timed out',
    'connection refused',
    'name or service not known',
    'ssl',
    '[error',
    'error: tool',
    'error: file',
    'error: directory',
    'circuitbreakeropen',
    'execution failed:',
];
const FILE_PRODUCING_TOOLS = {
    write_file: ['path'],
    edit_file: ['path'],
    copy_file: ['dst', 'destination'],
    move_file: ['dst', 'destination'],
};
// Tool-signature loop detector tuning.
const SIG_WINDOW = 8;
const SIG_LOOP_HINT = 4;
const SIG_LOOP_HARDSTOP = 6;
// ── Helper functions (module-level, same scope as Python globals) ───────────
function parseToolArgs(raw) {
    if (!raw || !raw.trim())
        return null;
    let cleaned = raw.trim();
    // 1. Direct parse
    try {
        return JSON.parse(cleaned);
    }
    catch {
        /* pass */
    }
    // 2. Strip markdown fences
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.includes('\n') ? cleaned.split('\n').slice(1).join('\n') : cleaned.slice(3);
        if (cleaned.includes('```'))
            cleaned = cleaned.split('```')[0];
        cleaned = cleaned.trim();
        try {
            return JSON.parse(cleaned);
        }
        catch {
            /* pass */
        }
    }
    // 3. Extract first JSON object/array
    const objMatch = RE_OBJ_OR_ARRAY.exec(cleaned);
    if (objMatch) {
        cleaned = objMatch[1];
        try {
            return JSON.parse(cleaned);
        }
        catch {
            /* pass */
        }
    }
    // 4. Key=value format
    if (!cleaned.startsWith('{') && RE_KV_DETECT.test(cleaned)) {
        const kvPairs = [];
        for (const m of cleaned.matchAll(RE_KV_PAIRS)) {
            let val = m[2];
            if (val.startsWith("'") && val.endsWith("'"))
                val = `"${val.slice(1, -1)}"`;
            kvPairs.push(`"${m[1]}": ${val}`);
        }
        if (kvPairs.length) {
            let jsonStr = '{' + kvPairs.join(', ') + '}';
            jsonStr = jsonStr.replace(RE_NONE_LITERAL, ': null$1');
            jsonStr = jsonStr.replace(RE_TRUE_LITERAL, ': true$1');
            jsonStr = jsonStr.replace(RE_FALSE_LITERAL, ': false$1');
            return JSON.parse(jsonStr);
        }
    }
    // 5. Python → JSON literals
    cleaned = cleaned.replace(RE_PY_NONE, 'null');
    cleaned = cleaned.replace(RE_PY_TRUE, 'true');
    cleaned = cleaned.replace(RE_PY_FALSE, 'false');
    // 6. Backtick → double quote
    cleaned = cleaned.replace(/`/g, '"');
    // 7. Single quote → double quote
    if (cleaned.includes("'"))
        cleaned = cleaned.replace(/'/g, '"');
    // 8. Unquoted keys
    cleaned = cleaned.replace(RE_UNQUOTED_KEY, '$1"$2"$3');
    // 9. Trailing commas
    cleaned = cleaned.replace(RE_TRAILING_COMMA, '$1');
    cleaned = cleaned.replace(/,$/, '').trim();
    // 10. Unquoted string values
    cleaned = cleaned.replace(RE_UNQUOTED_STRING, (m, g1, g2, g3) => {
        if (g2 === 'null' || g2 === 'true' || g2 === 'false')
            return m;
        if (/^-?\d/.test(g2) && /^[\d.]+$/.test(g2))
            return m;
        if (g2.startsWith('"') || g2.startsWith('{') || g2.startsWith('['))
            return m;
        return `${g1}"${g2}"${g3}`;
    });
    // 11. Try parse
    try {
        return JSON.parse(cleaned);
    }
    catch {
        /* pass */
    }
    // 12. Balanced-brace extraction
    let depth = 0, start = -1;
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') {
            if (depth === 0)
                start = i;
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                try {
                    return JSON.parse(cleaned.slice(start, i + 1));
                }
                catch {
                    /* pass */
                }
            }
        }
    }
    if (start >= 0 && depth > 0) {
        try {
            return JSON.parse(cleaned.slice(start) + '}'.repeat(depth));
        }
        catch {
            /* pass */
        }
    }
    return null;
}
function looksLikeFailedToolResult(result) {
    if (!result)
        return true;
    const head = result.slice(0, 300).toLowerCase();
    return TOOL_FAILURE_MARKERS.some((m) => head.includes(m));
}
function formatArgsParseError(toolName, rawArgs) {
    const stripped = rawArgs.trimEnd();
    const hasClosingBrace = stripped.endsWith('}') || stripped.endsWith(']');
    let inString = false;
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (ch === '\\' && inString) {
            i += 1;
            continue;
        }
        if (ch === '"')
            inString = !inString;
    }
    const looksTruncated = inString || !hasClosingBrace;
    const preview = rawArgs.length > 200 ? rawArgs.slice(0, 200) + '...[truncated]' : rawArgs;
    if (looksTruncated) {
        return `Error: tool '${toolName}' arguments were truncated by the model's output budget (max_tokens). The JSON ended mid-value so it cannot be parsed. For large content, split into multiple smaller calls (write_file with a shorter chunk, then edit_file or write_file to append the rest), or break the deliverable into pieces. Args preview: ${preview}`;
    }
    return `Error: invalid JSON in tool call arguments for '${toolName}': ${preview}`;
}
function toolCallSignature(toolName, args) {
    const a = args ?? {};
    const s = (key, n) => {
        const v = a[key];
        if (typeof v !== 'string')
            return '';
        return n ? v.trim().slice(0, n) : v.trim();
    };
    if (toolName === 'edit_file') {
        const osVal = s('old_text');
        if (osVal)
            return `edit_file:${s('path')}#${createHash('sha1').update(osVal).digest('hex').slice(0, 8)}`;
        return `edit_file:${s('path')}`;
    }
    if (['write_file', 'read_file', 'delete_file'].includes(toolName))
        return `${toolName}:${s('path')}`;
    if (['copy_file', 'move_file'].includes(toolName))
        return `${toolName}:${s('src') || s('source')}->${s('dst') || s('destination')}`;
    if (['run_bash', 'bash', 'shell', 'run_shell'].includes(toolName)) {
        const cmd = s('command') || s('cmd');
        if (!cmd)
            return toolName;
        return `${toolName}:${cmd.split(/\s+/)[0]?.slice(0, 30) ?? ''}`;
    }
    if (['web_search', 'search', 'search_web', 'search_files', 'grep'].includes(toolName)) {
        let q = s('query', 40) || s('pattern', 40);
        q = q.replace(/[\s"'「」『』"''""'']/g, '');
        return `${toolName}:${q.toLowerCase().slice(0, 30)}`;
    }
    if (toolName === 'delegate_to')
        return `delegate_to:${s('agent')}`;
    return toolName;
}
function textSimilarity(a, b) {
    if (a.length < 12 || b.length < 12)
        return 0.0;
    return ratio(a, b);
}
function suggestToolNames(missing, registry, maxN = 3) {
    const allNames = registry.listNames();
    if (!allNames.length)
        return [];
    const close = getCloseMatches(missing, allNames, maxN, 0.5);
    if (close.length)
        return close;
    const missingLower = missing.toLowerCase();
    let chunks = missingLower.split('_').filter((c) => c.length >= 3);
    if (!chunks.length && missingLower.length >= 3)
        chunks = [missingLower];
    const nameScored = [];
    const descScored = [];
    for (const n of allNames) {
        let ns = 0;
        for (const chunk of chunks) {
            if (n.toLowerCase().includes(chunk))
                ns += 2;
        }
        for (const chunk of n.toLowerCase().split('_')) {
            if (chunk.length >= 3 && missingLower.includes(chunk))
                ns += 1;
        }
        if (ns > 0)
            nameScored.push([ns, n]);
        const tool = registry.get(n);
        if (!tool)
            continue;
        const desc = tool.description.toLowerCase();
        const ds = chunks.filter((c) => desc.includes(c)).length;
        if (ds > 0)
            descScored.push([ds, n]);
    }
    if (nameScored.length) {
        nameScored.sort((a, b) => b[0] - a[0]);
        return nameScored.slice(0, maxN).map(([, n]) => n);
    }
    descScored.sort((a, b) => b[0] - a[0]);
    return descScored.slice(0, maxN).map(([, n]) => n);
}
function toolStatusLabel(name, args) {
    const tpl = TOOL_LABELS[name];
    let label = '';
    if (tpl) {
        label = tpl.replace(/\{(\w+)\}/g, (_, k) => (k in args ? String(args[k]) : `{${k}}`));
    }
    else {
        label = `${name}...`;
    }
    return label.length > 60 ? label.slice(0, 57) + '...' : label;
}
function synthesizeDelegationSummary(delegations) {
    if (!delegations.length)
        return '';
    const ok = delegations.filter(([, s]) => s).map(([n]) => n);
    const failed = delegations.filter(([, s]) => !s).map(([n]) => n);
    const parts = [];
    if (ok.length)
        parts.push('Delegated: ' + ok.join(', '));
    if (failed.length)
        parts.push('Failed: ' + failed.join(', '));
    return '[' + parts.join(' | ') + ']';
}
function extractFilePathsFromMessages(msgs) {
    const toolResults = new Map();
    for (const m of msgs) {
        if (m.role === 'tool' && m.toolCallId)
            toolResults.set(m.toolCallId, m.content || '');
    }
    const paths = [];
    const seen = new Set();
    for (const m of msgs) {
        if (m.role !== 'assistant' || !m.toolCalls)
            continue;
        for (const tc of m.toolCalls) {
            const name = tc.function?.name ?? '';
            const argKeys = FILE_PRODUCING_TOOLS[name];
            if (!argKeys)
                continue;
            let args = null;
            try {
                const raw = tc.function?.arguments ?? '';
                args = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
                if (typeof args !== 'object' || args === null)
                    continue;
            }
            catch {
                continue;
            }
            let path = null;
            for (const k of argKeys) {
                if (typeof args[k] === 'string' && args[k].trim()) {
                    path = args[k].trim();
                    break;
                }
            }
            if (!path)
                continue;
            const result = toolResults.get(tc.id ?? '') ?? '';
            if (result &&
                (result.startsWith('Error:') || result.startsWith('[Error') || result.startsWith('Error ')))
                continue;
            if (!seen.has(path)) {
                seen.add(path);
                paths.push(path);
            }
        }
    }
    return paths;
}
function enrichResponseWithArtifacts(content, filePaths) {
    if (!filePaths.length)
        return content;
    const body = content || '';
    const missing = filePaths.filter((p) => !body.includes(p));
    if (!missing.length && filePaths.every((p) => body.includes(p)))
        return body;
    const lines = ['', '> **Artifacts produced**'];
    for (const p of filePaths) {
        const marker = body.includes(p) ? ' — already cited above' : '';
        lines.push(`> - \`${p}\`${marker}`);
    }
    return body.trimEnd() + '\n\n' + lines.join('\n');
}
export class BaseAgent {
    static agentName = '';
    static agentDisplayName = '';
    static agentEmoji = '';
    static agentSpecialty = '';
    static agentSystemPrompt = '';
    static agentSystemPromptEn = '';
    static agentSkillNames = [];
    config;
    llm;
    bus;
    toolRegistry;
    skillRegistry;
    state = AgentState.IDLE;
    memory;
    tools = [];
    skills = [];
    activeSkills = new Set();
    skillConfigOverrides = new Map();
    baseSystemPrompt = '';
    maxToolRounds;
    maxToolRoundsHardCap = 40;
    userTurnsSinceExtract = 0;
    pendingExtracts = new Set();
    pendingRequests = new Map();
    bgTasks = new Set();
    turnLock = new Mutex();
    recallCache = null;
    /** Human-in-loop approval gate. null = auto-approve. */
    approvalCallback = null;
    constructor(config, llm, bus, toolRegistry, skillRegistry) {
        this.config = config;
        this.llm = llm;
        this.bus = bus;
        this.toolRegistry = toolRegistry;
        this.skillRegistry = skillRegistry ?? new SkillRegistry();
        this.memory = new Memory(config.memory, this.name);
        const agentCfg = config.agents[this.name];
        this.maxToolRounds = agentCfg?.maxToolRounds ?? 20;
    }
    /** Instance-level getters that read the class-level static values. */
    get name() {
        return this.constructor.agentName;
    }
    get displayName() {
        return this.constructor.agentDisplayName;
    }
    get emoji() {
        return this.constructor.agentEmoji;
    }
    get specialty() {
        return this.constructor.agentSpecialty;
    }
    get systemPrompt() {
        return this.constructor.agentSystemPrompt;
    }
    get skillNames() {
        return this.constructor.agentSkillNames;
    }
    resolveSystemPrompt() {
        const lang = this.config.llm.language ?? 'zh';
        if (lang === 'en') {
            const cls = this.constructor;
            if (cls.agentSystemPromptEn)
                return cls.agentSystemPromptEn;
        }
        return this.systemPrompt;
    }
    injectWorkspaceInfo(prompt) {
        const wsRoot = resolveWorkspacePath(this.config.workspace.path);
        initWorkspace(wsRoot);
        const lang = this.config.llm.language ?? 'zh';
        const wsBlock = lang === 'en'
            ? `\n\n## Workspace\n\`${wsRoot}\` — write to \`files/\`, \`output/\`, \`temp/\`. Prefer workspace paths for all file ops.`
            : `\n\n## 工作空间\n\`${wsRoot}\` — 产物写到 \`files/\` / \`output/\` / \`temp/\`。文件操作优先用此路径。`;
        return prompt + wsBlock;
    }
    currentTimeTag() {
        const now = Date.now() / 1000;
        if (_timeTag !== null && now - _timeTagTs < 30)
            return _timeTag;
        const d = new Date();
        const tag = `Today is ${d.toISOString().slice(0, 10)}. Current time: ${d.toISOString().replace('T', ' ').slice(0, 19)}.`;
        _timeTag = tag;
        _timeTagTs = now;
        return tag;
    }
    injectBehaviorRules(prompt) {
        const lang = this.config.llm.language ?? 'zh';
        const rules = lang === 'en'
            ? '\n\n## Behavior\n- Act, don\'t narrate. No "I will..." before tool calls.\n- Stay in scope. Do what\'s asked, then stop.\n- Batch independent tool calls in one response.\n- Verify writes: read back, report verified state.\n- No decorative `---` lines; no emoji in generated web pages.\n- Call list_skills when the task needs specialized capabilities (pptx, xlsx, pdf, web design, code review, etc.).'
            : '\n\n## 行为守则\n- 直接行动,不预告。不说「我将要...」,直接调用工具\n- 不擅自扩大范围。用户要什么做什么,核心完成即止\n- 独立的工具调用一次发出,并行执行\n- 写入后回读验证,汇报已验证状态而非仅尝试\n- 不用 `---` 装饰线,网页里不用 emoji\n- 任务涉及专业能力时（PPT/Excel/PDF/网页设计/代码审查等），先调 list_skills 查看可用技能，再用 use_skill 激活';
        return prompt + rules;
    }
    injectProgrammingWisdom(prompt) {
        const lang = this.config.llm.language ?? 'zh';
        const wisdom = lang === 'en'
            ? "\n\n## Engineering\nTop-tier engineer: type-safe code, real error handling, debugging by root cause, reviewing for security & perf. You can read and modify Weather Agents' own source."
            : '\n\n## 工程能力\n顶级工程师:类型安全、真实的错误处理、按根因调试、按安全与性能审查。你可以阅读和修改 Weather Agents 自身源码。';
        return prompt + wisdom;
    }
    reinitLanguage() {
        this.baseSystemPrompt = '';
        this.baseSystemPrompt = this.resolveSystemPrompt();
        this.baseSystemPrompt = this.injectWorkspaceInfo(this.baseSystemPrompt);
        this.baseSystemPrompt = this.injectBehaviorRules(this.baseSystemPrompt);
        this.baseSystemPrompt = this.injectProgrammingWisdom(this.baseSystemPrompt);
        this.baseSystemPrompt += '\n\n' + this.currentTimeTag();
        this.rebuildSystemPrompt();
    }
    async init() {
        if (this.baseSystemPrompt)
            return;
        await this.memory.initDb();
        if (this.memory.getActiveSession() === null) {
            let resumed = null;
            if (process.env.WA_NO_RESUME !== '1')
                resumed = await this.memory.resumeLatestSession();
            if (resumed === null)
                await this.memory.createSession();
        }
        this.baseSystemPrompt = this.resolveSystemPrompt();
        this.baseSystemPrompt = this.injectWorkspaceInfo(this.baseSystemPrompt);
        this.baseSystemPrompt = this.injectBehaviorRules(this.baseSystemPrompt);
        this.baseSystemPrompt = this.injectProgrammingWisdom(this.baseSystemPrompt);
        this.baseSystemPrompt += '\n\n' + this.currentTimeTag();
        this.rebuildSystemPrompt();
        this.tools = this.toolRegistry.getTools();
        this.loadSkills();
        this.bus.subscribe(this.name, this.handleEvent.bind(this));
    }
    loadSkills() {
        this.skills = this.skillRegistry.getSkills();
        this.registerSkillTools();
    }
    registerSkillTools() {
        if (this.toolRegistry.get('use_skill'))
            return;
        this.toolRegistry.register(new Tool({
            name: 'list_skills',
            description: 'List all available skills with their names and descriptions. Use this first to discover what skills you can activate.',
            parameters: [],
            handler: async () => {
                const skills = this.getAvailableSkills();
                if (!skills.length)
                    return 'No skills available.';
                const maxName = Math.max(...skills.map((s) => s.name.length), 0);
                return ('Available skills:\n' +
                    skills
                        .map((s) => `  ${s.name.padEnd(maxName)} — ${s.description}${s.active ? ' ★' : ''}`)
                        .join('\n'));
            },
        }));
        this.toolRegistry.register(new Tool({
            name: 'use_skill',
            description: 'Activate a named skill to gain specialized capabilities (e.g. code_reviewer for code review, web_research for research). Call list_skills first to see available options.',
            parameters: [
                {
                    name: 'name',
                    type: 'string',
                    description: 'The name of the skill to activate',
                    required: true,
                },
            ],
            handler: async (a) => {
                if (this.activateSkill(a.name)) {
                    const skill = this.skills.find((s) => s.name === a.name);
                    return `✓ Skill '${a.name}' activated: ${skill?.description ?? ''}`;
                }
                return `✗ Skill '${a.name}' not found. Call list_skills to see available options.`;
            },
        }));
        this.toolRegistry.register(new Tool({
            name: 'extend_rounds',
            description: 'Extend the tool-call budget for the current turn. Call this when you know you need more iterations to finish.',
            parameters: [
                {
                    name: 'n',
                    type: 'integer',
                    description: 'Number of additional rounds to add (default 10)',
                    required: false,
                },
            ],
            handler: async (a) => {
                const n = Number(a.n) || 10;
                const old = this.maxToolRounds;
                this.maxToolRounds += n;
                return `✓ Tool-round limit extended by ${n} (was ${old}, now ${this.maxToolRounds}). You have more iterations to complete the task.`;
            },
        }));
    }
    activateSkill(name) {
        let skill = this.skills.find((s) => s.name === name) ?? null;
        if (!skill) {
            skill = this.skillRegistry.get(name);
            if (skill)
                this.skills.push(skill);
        }
        if (!skill)
            return false;
        this.activeSkills.add(name);
        const overrides = {};
        if (skill.model)
            overrides.model = skill.model;
        if (skill.temperature !== null)
            overrides.temperature = skill.temperature;
        if (skill.maxTokens !== null)
            overrides.max_tokens = skill.maxTokens;
        if (Object.keys(overrides).length)
            this.skillConfigOverrides.set(name, overrides);
        this.rebuildSystemPrompt();
        return true;
    }
    deactivateSkill(name) {
        if (!this.activeSkills.has(name))
            return false;
        this.activeSkills.delete(name);
        this.skillConfigOverrides.delete(name);
        this.rebuildSystemPrompt();
        return true;
    }
    deactivateAllSkills() {
        for (const name of [...this.activeSkills])
            this.deactivateSkill(name);
    }
    autoActivateSkills(message) {
        if (!message)
            return [];
        const lowered = message.toLowerCase();
        const candidates = [...this.skills];
        for (const s of this.skillRegistry.getSkills()) {
            if (!candidates.find((c) => c.name === s.name))
                candidates.push(s);
        }
        const activated = [];
        for (const skill of candidates) {
            if (this.activeSkills.has(skill.name) || !skill.triggers.length)
                continue;
            if (skill.triggers.some((t) => t && lowered.includes(t.toLowerCase()))) {
                if (this.activateSkill(skill.name))
                    activated.push(skill.name);
            }
        }
        return activated;
    }
    runtimeIdentityBlock() {
        let model = this.config.llm.defaultModel;
        try {
            const agentCfg = this.config.agents[this.name];
            if (agentCfg?.model)
                model = agentCfg.model;
        }
        catch {
            /* pass */
        }
        const lang = this.config.llm.language ?? 'zh';
        if (lang === 'en')
            return `\n\n## Runtime\nYou are the ${this.displayName} agent in Weather Agents, powered by the **${model}** language model. If the user asks what model you are, give them this exact model id verbatim — do NOT guess or claim to be a different model.`;
        return `\n\n## 运行环境\n你是 Weather Agents 中的「${this.displayName}」智能体，底层语言模型为 **${model}**。如果用户问你是什么模型，直接告诉他们这个准确的 model id —— 不要猜测、不要冒充其他模型。`;
    }
    rebuildSystemPrompt() {
        const identity = this.runtimeIdentityBlock();
        let prompt = this.baseSystemPrompt;
        if (this.activeSkills.size) {
            const byName = new Map(this.skills.map((s) => [s.name, s]));
            const parts = [];
            for (const name of [...this.activeSkills].sort()) {
                const s = byName.get(name);
                if (!s)
                    continue;
                const sp = [];
                if (s.systemPrompt)
                    sp.push(s.systemPrompt);
                const lang = this.config.llm.language ?? 'zh';
                if (s.bodyTruncated && s.sourcePath) {
                    sp.push(lang === 'en'
                        ? `[Lazy-loaded skill: only the summary is in your prompt. Full guide at \`${s.sourcePath}\` — call read_file on that path when you need detailed instructions or examples.]`
                        : `[此技能为懒加载：当前提示中只放了摘要。完整指南位于 \`${s.sourcePath}\` —— 需要详细步骤或示例时，用 read_file 读取该文件。]`);
                }
                if (s.resourceDir)
                    sp.push(lang === 'en' ? `Resource directory: ${s.resourceDir}` : `资源目录: ${s.resourceDir}`);
                parts.push(sp.join('\n\n'));
            }
            prompt += '\n\n' + parts.join('\n\n');
        }
        prompt += identity;
        for (const msg of this.memory.shortTerm) {
            if (msg.role === 'system') {
                msg.content = prompt;
                return;
            }
        }
        this.memory.addMessage('system', prompt);
    }
    getActiveSkills() {
        return [...this.activeSkills];
    }
    getSkillConfigOverrides() {
        const merged = {};
        for (const overrides of this.skillConfigOverrides.values())
            Object.assign(merged, overrides);
        return merged;
    }
    getAvailableSkills() {
        return this.skills.map((s) => ({
            name: s.name,
            description: s.description,
            active: this.activeSkills.has(s.name),
        }));
    }
    async close() {
        const pending = [...this.pendingExtracts, ...this.bgTasks];
        if (pending.length) {
            try {
                await Promise.race([
                    Promise.all(pending.map((p) => p.catch(() => { }))),
                    new Promise((r) => setTimeout(r, 10000)),
                ]);
            }
            catch {
                /* pass */
            }
        }
        await this.memory.close();
        this.bus.unsubscribe(this.name);
    }
    async setState(newState) {
        if (this.state === newState)
            return;
        const oldState = this.state;
        this.state = newState;
        const event = makeEvent(EventType.STATE_CHANGE, this.name, {
            data: { old_state: oldState, new_state: newState },
        });
        this.bus.addEvent(event);
        await this.bus.notifyStateChange(event);
    }
    async handleEvent(event) {
        if (event.type === EventType.TASK_ASSIGNED && event.target === this.name) {
            const task = new Task(event.data);
            const result = await this.executeTask(task);
            await this.bus.publish(makeEvent(EventType.TASK_COMPLETED, this.name, {
                target: event.source,
                data: { task_id: task.id, success: result.success, content: result.content },
            }));
        }
        else if (event.type === EventType.AGENT_REQUEST && event.target === this.name) {
            const pr = this.handleRequest(event);
            this.bgTasks.add(pr);
            pr.then(() => this.bgTasks.delete(pr)).catch(() => this.bgTasks.delete(pr));
        }
        else if (event.type === EventType.AGENT_RESPONSE && event.target === this.name) {
            this.handleResponse(event);
        }
    }
    async chatOneshot(prompt, opts = {}) {
        const overrides = {};
        if (opts.model !== undefined && opts.model !== null)
            overrides.model = opts.model;
        else {
            const lw = this.config.llm.lightweightModel;
            if (typeof lw === 'string' && lw.trim())
                overrides.model = lw;
        }
        if (opts.temperature !== undefined && opts.temperature !== null)
            overrides.temperature = opts.temperature;
        if (opts.maxTokens !== undefined && opts.maxTokens !== null)
            overrides.max_tokens = opts.maxTokens;
        const response = await this.llm.complete([{ role: 'user', content: prompt }], {
            agentName: this.name,
            tools: null,
            overrides: Object.keys(overrides).length ? overrides : null,
        });
        return response.content;
    }
    async chat(message, onStatus) {
        const release = await this.turnLock.acquire();
        try {
            return await this.chatImpl(message, onStatus ?? null);
        }
        finally {
            release();
        }
    }
    async chatImpl(message, onStatus) {
        await this.setState(AgentState.THINKING);
        this.memory.addMessage('user', message);
        if (this.shouldAutoCompact()) {
            try {
                await this.compact();
            }
            catch (exc) {
                log.warning('auto_compact_failed', { error: String(exc) });
            }
        }
        try {
            if (onStatus)
                onStatus('thinking...');
            const response = await this.llmLoop(onStatus);
            this.memory.addMessage('assistant', response.content, {
                toolCalls: response.toolCalls,
                reasoningContent: response.reasoningContent,
            });
            await this.setState(AgentState.IDLE);
            this.maybeExtractFacts();
            return response.content;
        }
        catch (e) {
            await this.setState(AgentState.ERROR);
            this.popLastUserMessage();
            this.memory.pruneDanglingToolCalls();
            const errMsg = `[${this.displayName}] Error: ${e instanceof Error ? e.message : String(e)}`;
            this.memory.addMessage('assistant', errMsg);
            return errMsg;
        }
    }
    async *chatStream(message) {
        const activatedNow = this.autoActivateSkills(message);
        const release = await this.turnLock.acquire();
        try {
            for await (const ev of this.chatStreamImpl(message, { autoActivated: activatedNow }))
                yield ev;
        }
        catch (e) {
            if (this.memory.shortTerm.length && this.memory.shortTerm.at(-1)?.role === 'user')
                this.popLastUserMessage();
            throw e;
        }
        finally {
            release();
        }
    }
    async *chatStreamImpl(message, opts = {}) {
        const { autoActivated = [] } = opts;
        await this.setState(AgentState.THINKING);
        this.memory.addMessage('user', message);
        let assistantStored = false;
        if (this.shouldAutoCompact()) {
            try {
                await this.compact();
            }
            catch (exc) {
                log.warning('auto_compact_failed', { error: String(exc) });
            }
        }
        const delegations = [];
        const suppressedTools = new Set();
        if (autoActivated.length) {
            suppressedTools.add('list_skills');
            this.memory.addMessage('system', `[Auto-activated skills: ${autoActivated.join(', ')}] These were chosen from your message's keywords; their prompts and tools are already loaded. Do NOT call list_skills — proceed directly with the task. Only call use_skill(name) if you need a DIFFERENT skill that wasn't auto-activated.`);
        }
        let recentToolOutcomes = [];
        let stuckHintInjected = false;
        let recentResponseTexts = [];
        let repetitionHintInjected = false;
        let recentToolSigs = [];
        let toolLoopHintInjected = false;
        let toolNamesCache = null;
        let cacheKey = null;
        const resolveToolNames = () => {
            const key = [
                [...suppressedTools].sort().join(','),
                [...this.activeSkills].sort().join(','),
            ];
            if (toolNamesCache !== null && cacheKey?.[0] === key[0] && cacheKey?.[1] === key[1])
                return toolNamesCache;
            const candidates = this.activeToolNames().filter((n) => !suppressedTools.has(n));
            const must = new Set(this.skills.filter((s) => this.activeSkills.has(s.name)).flatMap((s) => s.requiredTools));
            toolNamesCache = selectRelevantTools(this.toolRegistry, candidates, message, {
                mustInclude: must,
            });
            cacheKey = key;
            return toolNamesCache;
        };
        try {
            let fullContent = '';
            let roundLimit = this.maxToolRounds;
            let roundCount = 0;
            const MAX_ROUNDS = 200;
            while (roundCount < MAX_ROUNDS) {
                if (roundCount >= roundLimit) {
                    if (roundLimit >= this.maxToolRoundsHardCap)
                        break;
                    const extendBy = Math.min(15, this.maxToolRoundsHardCap - roundLimit);
                    roundLimit += extendBy;
                    this.maxToolRounds = roundLimit;
                    this.memory.addMessage('system', `[Auto-extended tool-round limit by ${extendBy} to ${roundLimit}. Continue working.]`);
                    continue;
                }
                roundCount += 1;
                roundLimit = Math.max(roundLimit, this.maxToolRounds);
                const msgs = await this.messagesWithRecall();
                const toolNames = resolveToolNames();
                const toolCallsReceived = [];
                let streamingReasoning = null;
                let streamUsage = null;
                let roundContent = '';
                for await (const event of this.llm.streamWithTools(msgs, {
                    agentName: this.name,
                    tools: toolNames?.length ? toolNames : null,
                    toolRegistry: toolNames?.length ? this.toolRegistry : null,
                    overrides: Object.keys(this.getSkillConfigOverrides()).length
                        ? this.getSkillConfigOverrides()
                        : null,
                })) {
                    if (event.type === 'content') {
                        fullContent += event.text;
                        roundContent += event.text;
                        yield { type: 'content', text: event.text };
                    }
                    else if (event.type === 'tool_call' && event.toolCall)
                        toolCallsReceived.push(event.toolCall);
                    else if (event.type === 'error') {
                        yield { type: 'content', text: `\n[Error: ${event.text}]` };
                        if (!assistantStored)
                            this.popLastUserMessage();
                        await this.setState(AgentState.IDLE);
                        return;
                    }
                    else if (event.type === 'reasoning' && event.text)
                        yield { type: 'reasoning', text: event.text };
                    else if (event.type === 'done') {
                        streamUsage = event.usage;
                        streamingReasoning = event.reasoningContent;
                    }
                }
                if (!toolCallsReceived.length) {
                    let finalContent = roundContent;
                    if (!fullContent.trim() && delegations.length)
                        finalContent = synthesizeDelegationSummary(delegations);
                    this.memory.addMessage('assistant', finalContent, {
                        reasoningContent: streamingReasoning,
                    });
                    assistantStored = true;
                    await this.setState(AgentState.IDLE);
                    this.maybeExtractFacts();
                    if (finalContent && finalContent !== roundContent)
                        yield { type: 'content', text: finalContent };
                    yield { type: 'done' };
                    return;
                }
                this.memory.addMessage('assistant', roundContent, {
                    toolCalls: toolCallsReceived,
                    reasoningContent: streamingReasoning,
                });
                assistantStored = true;
                if (streamUsage)
                    this.bus.addEvent(makeEvent(EventType.LLM_CALL, this.name, { data: { model: '', usage: streamUsage } }));
                // Phase 1: parse args, look up tools, emit status
                const toolPrep = [];
                for (const tc of toolCallsReceived) {
                    const toolName = tc.function.name;
                    const rawArgs = tc.function.arguments;
                    const toolArgs = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : (rawArgs ?? {});
                    const parseError = typeof rawArgs === 'string' && toolArgs === null
                        ? formatArgsParseError(toolName, rawArgs)
                        : null;
                    this.bus.addEvent(makeEvent(EventType.TOOL_CALL, this.name, {
                        data: { tool: toolName, args: toolArgs ?? {} },
                    }));
                    const label = toolArgs
                        ? toolStatusLabel(toolName, toolArgs)
                        : `${toolName} (unparseable args)`;
                    yield { type: 'tool_status', label, toolName, args: toolArgs ?? {} };
                    toolPrep.push({ tc, toolName, toolArgs, parseError, toolLabel: label });
                }
                // Phase 2: execute all tools in parallel
                const execOne = async (p) => {
                    if (p.toolArgs === null)
                        return { tc: p.tc, result: p.parseError, success: false, toolName: p.toolName };
                    const tool = this.toolRegistry.get(p.toolName);
                    if (!tool) {
                        const suggestions = suggestToolNames(p.toolName, this.toolRegistry);
                        const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
                        suppressedTools.add(p.toolName);
                        return {
                            tc: p.tc,
                            result: `Error: Tool '${p.toolName}' does not exist.${hint}`,
                            success: false,
                            toolName: p.toolName,
                        };
                    }
                    if (tool.dangerous) {
                        log.warning('dangerous_tool_call', {
                            tool: p.toolName,
                            agent: this.name,
                            tool_args: p.toolArgs ? { ...p.toolArgs } : {},
                        });
                        if (!(await this.checkToolApproval(p.toolName, p.toolArgs))) {
                            return {
                                tc: p.tc,
                                result: `[denied] dangerous tool '${p.toolName}' blocked`,
                                success: false,
                                toolName: p.toolName,
                            };
                        }
                    }
                    await this.setState(AgentState.ACTING);
                    try {
                        const result = await tool.execute(p.toolArgs, this.name);
                        return { tc: p.tc, result, success: true, toolName: p.toolName };
                    }
                    catch (exc) {
                        log.exception(`Tool '${p.toolName}' execution failed`, exc);
                        return {
                            tc: p.tc,
                            result: `Tool '${p.toolName}' execution failed: ${exc instanceof Error ? exc.message : String(exc)}`,
                            success: false,
                            toolName: p.toolName,
                        };
                    }
                };
                const execResults = await Promise.all(toolPrep.map((p) => execOne(p)));
                // Phase 3: record results
                let taskCompleted = false;
                for (const r of execResults) {
                    if (typeof r.result === 'string' && r.result.includes('[CircuitBreakerOpen]'))
                        suppressedTools.add(r.toolName);
                    if (r.toolName === 'task_done' && r.result === TASK_DONE_SENTINEL) {
                        taskCompleted = true;
                        const prep = toolPrep.find((p) => p.tc === r.tc);
                        const summary = (prep.toolArgs ?? {}).summary ?? '';
                        const displayResult = summary ? `[Task completed: ${summary}]` : '[Task completed]';
                        this.memory.addMessage('tool', displayResult, {
                            name: r.toolName,
                            toolCallId: r.tc.id,
                        });
                        yield {
                            type: 'tool_done',
                            label: summary ? `task_done: ${summary}` : 'task_done',
                            success: true,
                            toolName: 'task_done',
                            result: displayResult,
                        };
                        continue;
                    }
                    this.memory.addMessage('tool', r.result, { name: r.toolName, toolCallId: r.tc.id });
                    const prep = toolPrep.find((p) => p.tc === r.tc);
                    yield {
                        type: 'tool_done',
                        label: prep.toolLabel,
                        success: r.success,
                        toolName: r.toolName,
                        result: typeof r.result === 'string'
                            ? r.result.slice(0, 800)
                            : String(r.result ?? '').slice(0, 800),
                    };
                    if (r.toolName === 'delegate_to') {
                        const target = prep.toolArgs?.agent ?? '?';
                        delegations.push([target, r.success]);
                    }
                }
                if (taskCompleted) {
                    if (!assistantStored)
                        this.popLastUserMessage();
                    await this.setState(AgentState.IDLE);
                    yield { type: 'done' };
                    return;
                }
                // Stuck-loop detectors
                const normalizedRound = roundContent.trim();
                if (normalizedRound && recentResponseTexts.length) {
                    if (recentResponseTexts
                        .slice(-2)
                        .some((prev) => textSimilarity(normalizedRound, prev) >= 0.7) &&
                        !repetitionHintInjected) {
                        this.memory.addMessage('system', '[Stop narrating] Your last response is highly similar to your previous one — you are re-describing what you\'re about to do instead of doing it. Stop writing prose. Either: 1. Emit ONLY the next tool call(s) with no explanatory text, or 2. If the task is genuinely done, output the final deliverable and stop. Do NOT write another "I am now going to ..." or "接下来要 ..." paragraph.');
                        repetitionHintInjected = true;
                    }
                }
                recentResponseTexts.push(normalizedRound);
                if (recentResponseTexts.length > 3)
                    recentResponseTexts.shift();
                for (const p of toolPrep) {
                    if (['task_done', 'list_skills', 'use_skill'].includes(p.toolName))
                        continue;
                    const sig = toolCallSignature(p.toolName, p.toolArgs);
                    if (sig)
                        recentToolSigs.push(sig);
                }
                if (recentToolSigs.length > SIG_WINDOW)
                    recentToolSigs.splice(0, recentToolSigs.length - SIG_WINDOW);
                if (recentToolSigs.length) {
                    const counter = new Map();
                    for (const s of recentToolSigs)
                        counter.set(s, (counter.get(s) ?? 0) + 1);
                    let topSig = '', topCount = 0;
                    for (const [s, c] of counter) {
                        if (c > topCount) {
                            topSig = s;
                            topCount = c;
                        }
                    }
                    if (topCount >= SIG_LOOP_HINT && !toolLoopHintInjected) {
                        this.memory.addMessage('system', `[Tool loop] You have called \`${topSig}\` ${topCount} times in the last ${recentToolSigs.length} tool calls — you are iterating on the same operation without converging. STOP repeating it. Either: (1) accept the current state and write the final answer, (2) try a fundamentally different approach (different tool / different target), or (3) call task_done if the work is good enough.`);
                        toolLoopHintInjected = true;
                    }
                    if (topCount >= SIG_LOOP_HARDSTOP) {
                        this.memory.addMessage('assistant', `I have repeated \`${topSig}\` ${topCount} times without converging on a better outcome. Stopping here to avoid burning the rest of the round budget on the same micro-adjustment. Current artifacts (if any) are the final state.`);
                        yield {
                            type: 'content',
                            text: `\n\n[stuck] tool \`${topSig}\` repeated ${topCount}× in the last ${recentToolSigs.length} calls — stopping rather than micro-tuning further.\n`,
                        };
                        await this.setState(AgentState.IDLE);
                        yield { type: 'done' };
                        return;
                    }
                }
                for (const r of execResults) {
                    if (r.toolName === 'task_done')
                        continue;
                    const failed = !r.success || (typeof r.result === 'string' && looksLikeFailedToolResult(r.result));
                    recentToolOutcomes.push(!failed);
                    if (recentToolOutcomes.length > 6)
                        recentToolOutcomes.shift();
                }
                if (!stuckHintInjected &&
                    recentToolOutcomes.length >= 5 &&
                    recentToolOutcomes.filter(Boolean).length <= 1) {
                    this.memory.addMessage('system', '[Recovery hint] Your last several tool calls have mostly failed (blocked sources, no results, timeouts). Stop trying more variations of the same approach. Either: (1) synthesize a partial answer from any tool outputs that DID succeed, (2) draw on your general knowledge and clearly label it as such, or (3) ask the user for guidance. Do NOT keep calling tools that are failing — finalize your answer now.');
                    stuckHintInjected = true;
                }
                if (recentToolOutcomes.length >= 8 && recentToolOutcomes.every((v) => !v)) {
                    this.memory.addMessage('assistant', "I tried multiple approaches but every tool call is failing (the file/path may not exist, search backends are blocked, or the resource is unavailable). Please give me more context — a correct file path, an alternative source, or clarification on what you're looking for.");
                    yield {
                        type: 'content',
                        text: '\n\n[stuck] every recent tool call failed — stopping rather than burning more iterations.\n',
                    };
                    await this.setState(AgentState.IDLE);
                    yield { type: 'done' };
                    return;
                }
                const searchStorm = recentToolSigs.filter((s) => s.startsWith('web_search:') || s === 'fetch_page' || s === 'http_get').length;
                if (searchStorm >= 8 && !toolLoopHintInjected) {
                    this.memory.addMessage('system', `[Search storm] You have made ${searchStorm} web-search / fetch calls in the last few rounds — far more than a productive research session needs. The queries are not converging on an answer. STOP searching. Synthesize the best answer you can from what you already know, label any gaps clearly, and call task_done. Do NOT make another web_search or fetch_page call.`);
                    toolLoopHintInjected = true;
                }
                if (searchStorm >= 12) {
                    this.memory.addMessage('assistant', 'I have made too many search requests without finding the information. I will synthesize the best answer from available context.');
                    yield {
                        type: 'content',
                        text: `\n\n[stuck] excessive web searching (${searchStorm} calls) — stopping.\n`,
                    };
                    await this.setState(AgentState.IDLE);
                    yield { type: 'done' };
                    return;
                }
            }
            // Max iterations reached
            if (!assistantStored)
                this.popLastUserMessage();
            await this.setState(AgentState.IDLE);
            if (!fullContent.trim() && delegations.length) {
                const synth = synthesizeDelegationSummary(delegations);
                this.memory.addMessage('assistant', synth);
                yield { type: 'content', text: synth };
            }
            yield { type: 'truncated', reason: `max tool rounds (${this.maxToolRounds}) reached` };
            yield { type: 'done' };
        }
        catch (e) {
            if (!assistantStored)
                this.popLastUserMessage();
            await this.setState(AgentState.ERROR);
            yield { type: 'content', text: `\n[Error: ${e instanceof Error ? e.message : String(e)}]` };
            throw e;
        }
        finally {
            this.memory.pruneDanglingToolCalls();
        }
    }
    popLastUserMessage() {
        for (let i = this.memory.shortTerm.length - 1; i >= 0; i--) {
            if (this.memory.shortTerm[i].role === 'user') {
                this.memory.shortTerm.splice(i, 1);
                break;
            }
        }
    }
    async compact(keepRecent = 12) {
        const systemMsgs = this.memory.shortTerm.filter((m) => m.role === 'system' && !(m.content || '').startsWith('[Earlier-context digest'));
        const nonSystem = this.memory.shortTerm.filter((m) => m.role !== 'system');
        if (nonSystem.length <= keepRecent + 4)
            return 'context is already compact';
        const toSummarize = nonSystem.slice(0, -keepRecent);
        const recent = nonSystem.slice(-keepRecent);
        const directiveKeywords = [
            "don't",
            'do not',
            'never',
            'always',
            'must',
            'no ',
            '不要',
            '不准',
            '禁止',
            '必须',
            '一定',
            '记住',
        ];
        const directives = [];
        for (const m of toSummarize) {
            if (m.role !== 'user')
                continue;
            const c = (m.content || '').trim();
            if (!c || c.length > 300)
                continue;
            if (directiveKeywords.some((k) => c.toLowerCase().includes(k)))
                directives.push(c);
        }
        let text = '';
        for (const m of toSummarize) {
            let content = (m.content || '').slice(0, 300);
            if (m.toolCalls?.length)
                content += ` [tools: ${m.toolCalls.map((tc) => tc.function.name).join(',')}]`;
            text += `[${m.role}] ${content}\n`;
        }
        const prompt = "Produce a TERSE factual digest of the conversation below. Strict format rules:\n- Output bullet points only (one fact per line, prefix '- ').\n- No narrative, no 'previously you', no commentary, no apology.\n- Each bullet ≤ 80 chars: a single fact, decision, file path, or constraint.\n- Preserve every user directive (don't / never / 必须 / 禁止 / 记住) verbatim in quotes.\n- Maximum 12 bullets total. Drop trivial chit-chat.\n\n" +
            text;
        const resp = await this.llm.complete([{ role: 'user', content: prompt }], {
            agentName: this.name,
            overrides: Object.keys(this.getSkillConfigOverrides()).length
                ? this.getSkillConfigOverrides()
                : null,
        });
        const summary = resp.content.trim().slice(0, 800);
        const digestParts = [
            `[Earlier-context digest — ${toSummarize.length} messages compressed. Reference only. Do NOT acknowledge, continue, or re-narrate this digest.]`,
            summary,
        ];
        if (directives.length) {
            digestParts.push('Verbatim user directives to obey:');
            directives.slice(-8).forEach((d) => digestParts.push(`  - "${d}"`));
        }
        this.memory.shortTerm = systemMsgs.slice();
        this.memory.addMessage('system', digestParts.join('\n'));
        this.memory.shortTerm.push(...recent);
        this.memory.pruneToolMessages();
        return `compressed ${toSummarize.length} messages (${summary.length} char digest)`;
    }
    contextUsage() {
        const usage = this.memory.getContextWindowUsage();
        const model = this.llm._getModel
            ? this.llm._getModel(this.name)
            : this.config.llm.defaultModel;
        const maxCtx = getModelContextWindow(model);
        const estTokens = usage.estimated_tokens;
        return {
            estimatedTokens: estTokens,
            maxTokens: maxCtx,
            pct: maxCtx ? Math.trunc((estTokens / maxCtx) * 100) : 0,
            messageCount: usage.message_count,
            model,
        };
    }
    shouldAutoCompact() {
        const usage = this.memory.getContextWindowUsage();
        const model = this.llm._getModel
            ? this.llm._getModel(this.name)
            : this.config.llm.defaultModel;
        const maxCtx = getModelContextWindow(model);
        return usage.estimated_tokens > maxCtx * 0.92;
    }
    activeToolNames() {
        let names = this.toolRegistry.listNames();
        const seen = new Set(names);
        let restriction = null;
        let anyUnrestricted = false;
        for (const skill of this.skills) {
            if (!this.activeSkills.has(skill.name))
                continue;
            for (const tn of skill.requiredTools) {
                if (!seen.has(tn)) {
                    names.push(tn);
                    seen.add(tn);
                }
            }
            if (skill.allowedTools === null)
                anyUnrestricted = true;
            else {
                if (restriction === null)
                    restriction = new Set();
                for (const t of skill.allowedTools)
                    restriction.add(t);
            }
        }
        if (restriction !== null && !anyUnrestricted)
            names = names.filter((n) => restriction.has(n));
        return names;
    }
    maybeExtractFacts() {
        if (process.env.WA_NO_EXTRACT === '1')
            return;
        const everyN = Number(process.env.WA_EXTRACT_EVERY_N ?? '20') || 20;
        if (everyN <= 0)
            return;
        this.userTurnsSinceExtract += 1;
        if (this.userTurnsSinceExtract < everyN)
            return;
        this.userTurnsSinceExtract = 0;
        const pr = this.extractFactsAsync();
        this.pendingExtracts.add(pr);
        pr.then(() => this.pendingExtracts.delete(pr)).catch(() => this.pendingExtracts.delete(pr));
    }
    async extractFactsAsync() {
        try {
            const recent = this.memory.shortTerm.slice(-20);
            const convoMsgs = recent.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
            if (convoMsgs.length < 4)
                return 0;
            const convoText = convoMsgs
                .map((m) => `${m.role}: ${(m.content ?? '').slice(0, 500)}`)
                .join('\n');
            const prompt = `你是一个事实抽取助手。从下面的对话中抽取**用户透露的稳定、可复用的事实**。\n\n**应该抽取**：\n- 工具/技术偏好（pkg_mgr=pnpm, editor=neovim, framework=FastAPI）\n- 项目信息（project_lang=Python, project_name=weather-agents）\n- 长期目标（goal=build_url_shortener）\n- 关键约束（os=Windows, python_version=3.13）\n\n**不要抽取**：\n- 用户的情绪、心情\n- 当前任务的临时细节\n- 对话过程中的中间产物\n- 任何不确定的信息\n\n**规则**：\n- 只在用户**明确陈述**时抽取\n- key 用 snake_case 英文，value 简短\n- 如无可抽取的稳定事实，输出 \`[]\`\n\n**输出格式**：纯 JSON 数组，不要任何额外文字、不要 markdown 围栏：\n[{"key": "pkg_mgr", "value": "pnpm", "category": "user_pref"}]\n\n对话：\n${convoText}\n\n输出：`;
            const response = await this.llm.complete([{ role: 'user', content: prompt }], {
                agentName: `${this.name}_extract`,
                tools: null,
            });
            const facts = this.parseExtractedFacts(response.content);
            let written = 0;
            for (const f of facts) {
                const key = f.key;
                const value = f.value;
                const category = f.category ?? 'auto_extracted';
                if (typeof key !== 'string' ||
                    !key.trim() ||
                    value === null ||
                    value === '' ||
                    value === undefined)
                    continue;
                await this.memory.remember(key.trim(), value, String(category));
                written += 1;
            }
            if (written)
                log.info('auto_extracted_facts', { agent: this.name, count: written });
            return written;
        }
        catch (exc) {
            log.warning('fact_extract_failed', { error: String(exc) });
            return 0;
        }
    }
    parseExtractedFacts(content) {
        const text = (content || '').trim();
        if (!text)
            return [];
        try {
            const d = JSON.parse(text);
            if (Array.isArray(d))
                return d.filter((f) => f && typeof f === 'object');
        }
        catch {
            /* pass */
        }
        const m1 = RE_FENCED_JSON_ARRAY.exec(text);
        if (m1) {
            try {
                const d = JSON.parse(m1[1]);
                if (Array.isArray(d))
                    return d.filter((f) => f && typeof f === 'object');
            }
            catch {
                /* pass */
            }
        }
        const m2 = RE_JSON_ARRAY.exec(text);
        if (m2) {
            try {
                const d = JSON.parse(m2[0]);
                if (Array.isArray(d))
                    return d.filter((f) => f && typeof f === 'object');
            }
            catch {
                /* pass */
            }
        }
        return [];
    }
    async messagesWithRecall() {
        const msgs = this.memory.getMessages();
        if (!msgs.length || process.env.WA_NO_RECALL === '1')
            return msgs;
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0)
            return msgs;
        const query = String(msgs[lastUserIdx].content ?? '').slice(0, 200);
        if (query.trim().length < 4)
            return msgs;
        if (!this.recallCache)
            this.recallCache = {};
        let facts = this.recallCache[query];
        if (facts === undefined) {
            try {
                facts = await this.memory.recallForInjection(query, 3);
            }
            catch {
                return msgs;
            }
            this.recallCache[query] = facts;
            if (Object.keys(this.recallCache).length > 32) {
                const first = Object.keys(this.recallCache)[0];
                delete this.recallCache[first];
            }
        }
        if (!facts.length)
            return msgs;
        const block = Memory.formatFactsBlock(facts);
        if (!block)
            return msgs;
        msgs.splice(lastUserIdx, 0, { role: 'system', content: block });
        return msgs;
    }
    async llmLoop(onStatus, ephemeral = false) {
        const mi = this.maxToolRounds;
        const fullToolNames = this.activeToolNames();
        const lastUser = [...this.memory.shortTerm].reverse().find((m) => m.role === 'user');
        const must = new Set(this.skills.filter((s) => this.activeSkills.has(s.name)).flatMap((s) => s.requiredTools));
        const toolNames = selectRelevantTools(this.toolRegistry, fullToolNames, (lastUser?.content ?? '').trim() || '', { mustInclude: must });
        let limit = mi;
        let rounds = 0;
        while (true) {
            if (rounds >= limit) {
                if (limit >= this.maxToolRoundsHardCap)
                    break;
                const extendBy = Math.min(15, this.maxToolRoundsHardCap - limit);
                limit += extendBy;
                this.maxToolRounds = limit;
                this.memory.addMessage('system', `[Auto-extended tool-round limit by ${extendBy} to ${limit}. Continue working.]`);
                continue;
            }
            rounds += 1;
            limit = Math.max(limit, this.maxToolRounds);
            const msgs = await this.messagesWithRecall();
            if (onStatus)
                onStatus('thinking...');
            const response = await this.llm.complete(msgs, {
                agentName: this.name,
                tools: toolNames?.length ? toolNames : null,
                overrides: Object.keys(this.getSkillConfigOverrides()).length
                    ? this.getSkillConfigOverrides()
                    : null,
            });
            if (!response.toolCalls.length)
                return response;
            this.bus.addEvent(makeEvent(EventType.LLM_CALL, this.name, {
                data: { model: response.model, usage: response.usage },
            }));
            this.memory.addMessage('assistant', response.content || '', {
                toolCalls: response.toolCalls,
                reasoningContent: response.reasoningContent,
                ephemeral,
            });
            for (const tc of response.toolCalls) {
                const toolName = tc.function.name;
                const rawArgs = tc.function.arguments;
                const toolArgs = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : (rawArgs ?? {});
                const parseError = typeof rawArgs === 'string' && toolArgs === null
                    ? formatArgsParseError(toolName, rawArgs)
                    : null;
                const tool = this.toolRegistry.get(toolName);
                this.bus.addEvent(makeEvent(EventType.TOOL_CALL, this.name, {
                    data: { tool: toolName, args: toolArgs ?? {} },
                }));
                if (onStatus)
                    onStatus(toolArgs ? toolStatusLabel(toolName, toolArgs) : `${toolName}...`);
                if (toolArgs === null) {
                    this.memory.addMessage('tool', parseError, {
                        name: toolName,
                        toolCallId: tc.id,
                        ephemeral,
                    });
                }
                else if (tool) {
                    if (tool.dangerous && !(await this.checkToolApproval(toolName, toolArgs))) {
                        this.memory.addMessage('tool', `[denied] dangerous tool '${toolName}' blocked`, {
                            name: toolName,
                            toolCallId: tc.id,
                            ephemeral,
                        });
                        continue;
                    }
                    await this.setState(AgentState.ACTING);
                    const result = await tool.execute(toolArgs, this.name);
                    this.memory.addMessage('tool', result, { name: toolName, toolCallId: tc.id, ephemeral });
                }
                else {
                    const suggestions = suggestToolNames(toolName, this.toolRegistry);
                    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
                    this.memory.addMessage('tool', `Error: Tool '${toolName}' does not exist.${hint}`, {
                        name: toolName,
                        toolCallId: tc.id,
                        ephemeral,
                    });
                }
            }
            await this.setState(AgentState.THINKING);
        }
        return {
            content: `[truncated] max tool rounds (${mi}) reached without a final answer; latest tool calls were not followed up.`,
            toolCalls: [],
            model: '',
            usage: {},
            cost: 0,
            reasoningContent: null,
            truncated: true,
        };
    }
    async executeTask(task, onStatus) {
        const release = await this.turnLock.acquire();
        try {
            return await this.executeTaskImpl(task, onStatus ?? null);
        }
        finally {
            release();
        }
    }
    async executeTaskImpl(task, onStatus) {
        await this.setState(AgentState.THINKING);
        task.transitionTo(TaskState.RUNNING);
        this.memory.setWorking('current_task', task);
        let prompt = 'Complete this task NOW using your available tools. Then write the actual deliverable content in your final reply.\n\n' +
            `Task: ${task.description}`;
        if (task.metadata) {
            const ctx = {};
            for (const [k, v] of Object.entries(task.metadata)) {
                if (k !== 'goal')
                    ctx[k] = v;
            }
            if (Object.keys(ctx).length)
                prompt += `\nContext: ${JSON.stringify(ctx)}`;
        }
        const savedShortTerm = this.memory.shortTerm.slice();
        this.memory.shortTerm = this.memory.shortTerm.filter((m) => m.role === 'system');
        this.memory.addMessage('user', prompt, { ephemeral: true });
        const preLen = this.memory.shortTerm.length;
        try {
            const response = await this.llmLoop(onStatus, true);
            const filePaths = extractFilePathsFromMessages(this.memory.shortTerm.slice(preLen));
            const enriched = enrichResponseWithArtifacts(response.content, filePaths);
            this.memory.addMessage('assistant', enriched, {
                toolCalls: response.toolCalls,
                reasoningContent: response.reasoningContent,
                ephemeral: true,
            });
            task.transitionTo(TaskState.COMPLETED);
            task.result = enriched;
            await this.setState(AgentState.IDLE);
            return { success: true, content: enriched, data: {} };
        }
        catch (e) {
            task.transitionTo(TaskState.FAILED);
            task.result = String(e instanceof Error ? e.message : e);
            this.memory.pruneDanglingToolCalls();
            await this.setState(AgentState.ERROR);
            return { success: false, content: String(e instanceof Error ? e.message : e), data: {} };
        }
        finally {
            this.memory.shortTerm = savedShortTerm;
        }
    }
    async checkToolApproval(toolName, toolArgs) {
        const mode = this.config.cli.approvalMode ?? 'auto';
        if (mode === 'strict') {
            log.info('tool_denied_strict', { tool: toolName });
            return false;
        }
        if (mode === 'interactive') {
            if (this.approvalCallback)
                return this.approvalCallback(toolName, toolArgs);
            log.info('tool_denied_no_callback', { tool: toolName });
            return false;
        }
        return true;
    }
    async requestHelp(targetAgent, description, timeoutS = 60) {
        const correlationId = randomUUID();
        let res, rej;
        const p = new Promise((resolve, reject) => {
            res = resolve;
            rej = reject;
        });
        this.pendingRequests.set(correlationId, { resolve: res, reject: rej });
        await this.bus.publish(makeEvent(EventType.AGENT_REQUEST, this.name, {
            target: targetAgent,
            data: { correlation_id: correlationId, description, source: this.name },
        }));
        const timer = setTimeout(() => {
            this.pendingRequests.delete(correlationId);
            rej(new Error(`[${targetAgent} did not respond within ${timeoutS}s]`));
        }, timeoutS * 1000);
        try {
            const result = await p;
            clearTimeout(timer);
            return result;
        }
        catch (e) {
            clearTimeout(timer);
            return e instanceof Error ? e.message : String(e);
        }
    }
    async handleRequest(event) {
        const description = String(event.data.description ?? '');
        const correlationId = String(event.data.correlation_id ?? '');
        const source = String(event.data.source ?? '');
        if (!correlationId)
            return;
        const task = new Task({
            id: `req-${correlationId.slice(0, 8)}`,
            description,
            assignedTo: this.name,
        });
        try {
            const result = await this.executeTask(task);
            await this.bus.publish(makeEvent(EventType.AGENT_RESPONSE, this.name, {
                target: source,
                data: { correlation_id: correlationId, content: result.content, success: result.success },
            }));
        }
        catch (exc) {
            await this.bus.publish(makeEvent(EventType.AGENT_RESPONSE, this.name, {
                target: source,
                data: {
                    correlation_id: correlationId,
                    content: `[error] ${String(exc)}`,
                    success: false,
                },
            }));
        }
    }
    handleResponse(event) {
        const correlationId = String(event.data.correlation_id ?? '');
        if (!correlationId)
            return;
        const entry = this.pendingRequests.get(correlationId);
        if (entry) {
            this.pendingRequests.delete(correlationId);
            entry.resolve(String(event.data.content ?? ''));
        }
    }
    getStatus() {
        const usage = this.llm.getUsageStats()[this.name] ?? {
            calls: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            cost: 0,
        };
        return {
            name: this.name,
            display_name: this.displayName,
            emoji: this.emoji,
            specialty: this.specialty,
            state: this.state,
            skills: this.getAvailableSkills(),
            usage: {
                calls: usage.calls,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                cost: Math.round((usage.cost ?? 0) * 1e6) / 1e6,
            },
        };
    }
}
