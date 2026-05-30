/** Configuration management for Weather Agents. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { getLogger } from './logger.js';
const log = getLogger('config');
export const USER_CONFIG_DIR = join(homedir(), '.weather-agents');
/** All agent names — single source of truth for config iteration and validation. */
export const AGENT_NAMES = ['fog', 'rain', 'frost', 'snow', 'dew', 'fair'];
const _here = dirname(fileURLToPath(import.meta.url));
/** Locate the config/ directory reliably in dev (tsx) and built (dist) modes. */
function findConfigDir() {
    // src/core/config.ts -> ../../config ; dist/core/config.js -> ../../config
    const bundled = join(_here, '..', '..', 'config');
    if (existsSync(join(bundled, 'default.yaml'))) {
        return bundled;
    }
    return join(USER_CONFIG_DIR, 'config');
}
export const CONFIG_DIR = findConfigDir();
// ── YAML helpers ────────────────────────────────────────────────────────────
function loadYaml(path) {
    if (existsSync(path)) {
        const parsed = yaml.load(readFileSync(path, 'utf-8'));
        return parsed || {};
    }
    return {};
}
function deepMerge(base, override) {
    for (const [k, v] of Object.entries(override)) {
        if (k in base &&
            base[k] &&
            typeof base[k] === 'object' &&
            !Array.isArray(base[k]) &&
            v &&
            typeof v === 'object' &&
            !Array.isArray(v)) {
            deepMerge(base[k], v);
        }
        else {
            base[k] = v;
        }
    }
}
function writeYaml(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml.dump(data, { noRefs: true }), 'utf-8');
    // Restrict to owner-only — this file holds API keys. No-op / best effort on
    // Windows; swallow EPERM so the CLI never crashes on a chmod.
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* ignore */
    }
    invalidateCache();
}
function saveUserCfg(data) {
    const path = join(USER_CONFIG_DIR, 'config.yaml');
    const existing = loadYaml(path);
    deepMerge(existing, data);
    mkdirSync(USER_CONFIG_DIR, { recursive: true });
    writeFileSync(path, yaml.dump(existing, { noRefs: true }), 'utf-8');
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* ignore */
    }
    invalidateCache();
}
/** Resolve ${VAR} placeholders to environment variables. */
function resolveEnv(value) {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const varName = value.slice(2, -1);
        const resolved = process.env[varName];
        if (resolved === undefined) {
            log.warning('env_var_missing', { var: varName });
            return '';
        }
        return resolved;
    }
    return value;
}
export function loadModelCatalog() {
    const path = join(CONFIG_DIR, 'models.yaml');
    if (!existsSync(path))
        return {};
    const data = loadYaml(path);
    const catalog = {};
    for (const [provider, models] of Object.entries(data)) {
        if (models && typeof models === 'object' && !Array.isArray(models)) {
            catalog[provider] = [];
            for (const [name, info] of Object.entries(models)) {
                const entry = { name };
                if (info && typeof info === 'object' && !Array.isArray(info)) {
                    Object.assign(entry, info);
                }
                else {
                    entry.provider = info;
                }
                catalog[provider].push(entry);
            }
        }
    }
    return catalog;
}
export function formatModelsForDisplay(catalog) {
    const lines = [];
    for (const [provider, models] of Object.entries(catalog)) {
        lines.push(`  [${provider.toUpperCase()}]`);
        for (const m of models) {
            const costParts = [];
            if (m.input_cost_per_1k)
                costParts.push(`$${m.input_cost_per_1k.toFixed(4)}/1k in`);
            if (m.output_cost_per_1k)
                costParts.push(`$${m.output_cost_per_1k.toFixed(4)}/1k out`);
            const costStr = costParts.length ? `  cost=(${costParts.join(', ')})` : '';
            const fallbackStr = m.fallback?.length ? `  fallback->${m.fallback.join(' > ')}` : '';
            lines.push(`    ${m.name}  (ctx=${m.context_window ?? '?'}, max=${m.max_output ?? '?'})${costStr}${fallbackStr}`);
        }
    }
    return lines.join('\n');
}
const _ctxCache = new Map();
export function getModelContextWindow(modelName) {
    if (typeof modelName !== 'string')
        return 128000;
    const cached = _ctxCache.get(modelName);
    if (cached !== undefined)
        return cached;
    const catalog = loadModelCatalog();
    for (const models of Object.values(catalog)) {
        for (const m of models) {
            if (m.name === modelName) {
                const val = Math.trunc(Number(m.context_window ?? 128000));
                _ctxCache.set(modelName, val);
                return val;
            }
        }
    }
    if (modelName.includes('/')) {
        return getModelContextWindow(modelName.split('/').slice(1).join('/'));
    }
    _ctxCache.set(modelName, 128000);
    return 128000;
}
// ── Provider catalog ──────────────────────────────────────────────────────────
let _providerCache = null;
export function loadProviderCatalog() {
    if (_providerCache !== null)
        return _providerCache;
    const catalog = {};
    const bundled = join(CONFIG_DIR, 'providers.yaml');
    if (existsSync(bundled)) {
        const data = loadYaml(bundled);
        for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                catalog[k] = { ...v };
            }
        }
    }
    const userPath = join(USER_CONFIG_DIR, 'providers.yaml');
    if (existsSync(userPath)) {
        const userData = loadYaml(userPath);
        for (const [k, v] of Object.entries(userData)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                catalog[k] = { ...(catalog[k] ?? {}), ...v };
            }
        }
    }
    if (Object.keys(catalog).length === 0) {
        Object.assign(catalog, {
            openai: { env_var: 'OPENAI_API_KEY', region: 'US' },
            anthropic: { env_var: 'ANTHROPIC_API_KEY', region: 'US' },
            deepseek: { env_var: 'DEEPSEEK_API_KEY', region: 'CN' },
            google_gemini: { env_var: 'GEMINI_API_KEY', region: 'US' },
            ollama: { env_var: 'OLLAMA_API_KEY', region: 'Local' },
        });
    }
    _providerCache = catalog;
    return catalog;
}
export function getProviderEnvVar(provider) {
    const cat = loadProviderCatalog();
    let entry = cat[provider.toLowerCase()];
    if (entry === undefined) {
        for (const v of Object.values(cat)) {
            const aliases = v.aliases;
            if (Array.isArray(aliases) &&
                aliases.map((a) => a.toLowerCase()).includes(provider.toLowerCase())) {
                entry = v;
                break;
            }
        }
    }
    if (entry && 'env_var' in entry) {
        return String(entry.env_var);
    }
    return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}
export function resolveProviderAlias(name) {
    if (!name)
        return name;
    const cat = loadProviderCatalog();
    const lower = name.toLowerCase();
    if (lower in cat)
        return lower;
    for (const [k, v] of Object.entries(cat)) {
        const aliases = v.aliases;
        if (Array.isArray(aliases) && aliases.map((a) => a.toLowerCase()).includes(lower)) {
            return k;
        }
    }
    return lower;
}
export function invalidateProviderCache() {
    _providerCache = null;
}
const AGENT_SPECIALTIES = {
    fog: '探索研究',
    rain: '生成创造',
    frost: '审查优化',
    snow: '规划编排',
    dew: '运维集成',
    fair: '情感陪伴',
};
export function defaultAppConfig() {
    const agents = {};
    for (const name of AGENT_NAMES) {
        agents[name] = { model: null, specialty: AGENT_SPECIALTIES[name], maxToolRounds: 20 };
    }
    return {
        llm: {
            defaultModel: 'deepseek/deepseek-v4-flash',
            lightweightModel: null,
            temperature: 0.7,
            maxTokens: 16384,
            timeout: 120,
            maxRetries: 2,
            apiKeys: {},
            language: 'zh',
        },
        agents,
        bus: { maxRetries: 3, retryDelay: 1.0 },
        memory: {
            dbPath: '~/.weather-agents/memory.db',
            shortTermLimit: 50,
            maxPersistedMessages: 1000,
        },
        web: { host: '127.0.0.1', port: 8765 },
        workspace: { path: 'auto' },
        tts: {
            enabled: false,
            provider: 'doubao',
            accessToken: '',
            apiKey: '',
            appId: '',
            resourceId: 'seed-tts-2.0',
            voiceType: 'zh_female_sajiaoxuemei_uranus_bigtts',
            encoding: 'mp3',
            sampleRate: 24000,
            speedRatio: 1.0,
            volumeRatio: 1.0,
            pitchRatio: 1.0,
            emotion: 'happy',
        },
        plugins: { enabled: true, directories: ['~/.weather-agents/plugins'] },
        mcp: { servers: [] },
        cli: {
            defaultAgent: 'fog',
            interactiveMode: 'default',
            approvalMode: 'auto',
            circuitFailureThreshold: 3,
            circuitRecoveryTimeout: 30.0,
            rateLimitMaxCalls: 30,
            rateLimitWindow: 60.0,
            auditEnabled: true,
        },
    };
}
// ── Config cache ───────────────────────────────────────────────────────────
let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 2.0; // seconds
export function invalidateCache() {
    _configCache = null;
    _configCacheTime = 0;
}
// ── env key map (legacy) ─────────────────────────────────────────────────────
const ENV_KEY_MAP = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
};
function syncApiKeysToEnv(apiKeys) {
    for (const [provider, key] of Object.entries(apiKeys)) {
        if (!key)
            continue;
        const envVar = ENV_KEY_MAP[provider] || getProviderEnvVar(provider);
        if (envVar) {
            process.env[envVar] = key;
        }
        else {
            process.env[`${provider.toUpperCase()}_API_KEY`] = key;
        }
    }
}
function loadDotenv() {
    for (const base of [process.cwd(), USER_CONFIG_DIR]) {
        const dotenvPath = join(base, '.env');
        if (!existsSync(dotenvPath))
            continue;
        try {
            for (let line of readFileSync(dotenvPath, 'utf-8').split(/\r?\n/)) {
                line = line.trim();
                if (!line || line.startsWith('#') || !line.includes('='))
                    continue;
                const eq = line.indexOf('=');
                const key = line.slice(0, eq).trim();
                let value = line.slice(eq + 1).trim();
                value = value.replace(/^["']|["']$/g, '');
                if (key && !(key in process.env)) {
                    process.env[key] = value;
                }
            }
        }
        catch {
            /* ignore */
        }
    }
}
function loadConfigUncached() {
    const cfg = defaultAppConfig();
    loadDotenv();
    const defaultData = loadYaml(join(CONFIG_DIR, 'default.yaml'));
    const userData = loadYaml(join(USER_CONFIG_DIR, 'config.yaml'));
    const merged = { ...defaultData };
    deepMerge(merged, userData);
    const llm = merged.llm;
    if (llm) {
        cfg.llm.defaultModel = llm.default_model ?? cfg.llm.defaultModel;
        cfg.llm.lightweightModel = llm.lightweight_model ?? cfg.llm.lightweightModel;
        cfg.llm.temperature = llm.temperature ?? cfg.llm.temperature;
        cfg.llm.maxTokens = llm.max_tokens ?? cfg.llm.maxTokens;
        cfg.llm.timeout = llm.timeout ?? cfg.llm.timeout;
        cfg.llm.language = llm.language ?? cfg.llm.language;
        if (llm.api_keys) {
            const keys = {};
            for (const [k, v] of Object.entries(llm.api_keys)) {
                keys[k] = String(resolveEnv(v));
            }
            cfg.llm.apiKeys = keys;
        }
    }
    const agents = merged.agents;
    if (agents) {
        for (const name of AGENT_NAMES) {
            const agentCfg = agents[name];
            if (agentCfg) {
                if (agentCfg.model)
                    cfg.agents[name].model = agentCfg.model;
                if (agentCfg.specialty)
                    cfg.agents[name].specialty = agentCfg.specialty;
                if (agentCfg.max_tool_rounds)
                    cfg.agents[name].maxToolRounds = Math.trunc(Number(agentCfg.max_tool_rounds));
            }
        }
    }
    const web = merged.web;
    if (web) {
        cfg.web.host = web.host ?? cfg.web.host;
        cfg.web.port = web.port ?? cfg.web.port;
    }
    const tts = merged.tts;
    if (tts) {
        cfg.tts.enabled = tts.enabled ?? false;
        cfg.tts.provider = tts.provider ?? cfg.tts.provider;
        cfg.tts.accessToken = tts.access_token ?? '';
        cfg.tts.apiKey = tts.api_key ?? '';
        cfg.tts.appId = tts.app_id ?? '';
        cfg.tts.resourceId = tts.resource_id ?? cfg.tts.resourceId;
        cfg.tts.voiceType = tts.voice_type ?? cfg.tts.voiceType;
        cfg.tts.encoding = tts.encoding ?? cfg.tts.encoding;
        cfg.tts.sampleRate = Math.trunc(Number(tts.sample_rate ?? 24000));
        cfg.tts.speedRatio = Number(tts.speed_ratio ?? 1.0);
        cfg.tts.volumeRatio = Number(tts.volume_ratio ?? 1.0);
        cfg.tts.pitchRatio = Number(tts.pitch_ratio ?? 1.0);
        cfg.tts.emotion = tts.emotion ?? cfg.tts.emotion;
    }
    if (!cfg.tts.apiKey) {
        const envKey = process.env.DOUBAO_TTS_API_KEY;
        if (envKey) {
            cfg.tts.apiKey = envKey;
            cfg.tts.enabled = true;
        }
    }
    const ws = merged.workspace;
    if (ws) {
        cfg.workspace.path = ws.path ?? cfg.workspace.path;
    }
    const mem = merged.memory;
    if (mem) {
        cfg.memory.dbPath = mem.db_path ?? cfg.memory.dbPath;
        cfg.memory.shortTermLimit = mem.short_term_limit ?? cfg.memory.shortTermLimit;
        cfg.memory.maxPersistedMessages = mem.max_persisted_messages ?? cfg.memory.maxPersistedMessages;
    }
    const cliCfg = merged.cli;
    if (cliCfg) {
        cfg.cli.defaultAgent = cliCfg.default_agent ?? cfg.cli.defaultAgent;
        cfg.cli.interactiveMode = cliCfg.interactive_mode ?? cfg.cli.interactiveMode;
        cfg.cli.approvalMode = cliCfg.approval_mode ?? cfg.cli.approvalMode;
        cfg.cli.circuitFailureThreshold = Math.trunc(Number(cliCfg.circuit_failure_threshold ?? cfg.cli.circuitFailureThreshold));
        cfg.cli.circuitRecoveryTimeout = Number(cliCfg.circuit_recovery_timeout ?? cfg.cli.circuitRecoveryTimeout);
        cfg.cli.rateLimitMaxCalls = Math.trunc(Number(cliCfg.rate_limit_max_calls ?? cfg.cli.rateLimitMaxCalls));
        cfg.cli.rateLimitWindow = Number(cliCfg.rate_limit_window ?? cfg.cli.rateLimitWindow);
        cfg.cli.auditEnabled = Boolean(cliCfg.audit_enabled ?? cfg.cli.auditEnabled);
    }
    const mcp = merged.mcp;
    if (mcp && Array.isArray(mcp.servers)) {
        const resolved = [];
        for (const s of mcp.servers) {
            if (s.enabled ?? true) {
                const env = {};
                for (const [k, v] of Object.entries(s.env ?? {})) {
                    env[k] = resolveEnv(v);
                }
                s.env = env;
            }
            else {
                s.env = s.env ?? {};
            }
            resolved.push(s);
        }
        cfg.mcp.servers = resolved;
    }
    // API keys from env vars (lowest priority).
    const envFallback = [
        ['openai', 'OPENAI_API_KEY'],
        ['anthropic', 'ANTHROPIC_API_KEY'],
        ['deepseek', 'DEEPSEEK_API_KEY'],
        ['google', 'GOOGLE_API_KEY'],
    ];
    for (const [provider, envVar] of envFallback) {
        if (!cfg.llm.apiKeys[provider] && process.env[envVar]) {
            cfg.llm.apiKeys[provider] = process.env[envVar];
        }
    }
    syncApiKeysToEnv(cfg.llm.apiKeys);
    return cfg;
}
/** Load config from default + user overrides + env vars, with TTL cache. */
export function loadConfig() {
    const now = performance.now() / 1000;
    if (_configCache !== null && now - _configCacheTime < CONFIG_CACHE_TTL) {
        return _configCache;
    }
    const cfg = loadConfigUncached();
    _configCache = cfg;
    _configCacheTime = now;
    return cfg;
}
// ── set / delete ────────────────────────────────────────────────────────────
const SIMPLE_LLM_KEYS = [
    'default_model',
    'lightweight_model',
    'temperature',
    'max_tokens',
    'timeout',
];
/** Set a config key and persist to user config. Returns [ok, message]. */
export function setConfig(key, value) {
    const parts = key.split('.');
    if (parts.length === 2 && parts[0] === 'api_key') {
        const provider = parts[1];
        saveUserCfg({ llm: { api_keys: { [provider]: value } } });
        return [true, `api_key.${provider} saved`];
    }
    if (parts.length === 2 && parts[0] === 'workspace') {
        if (parts[1] === 'path') {
            if (value.toLowerCase() !== 'auto') {
                const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value;
                if (!isAbsolute(expanded)) {
                    return [false, `workspace path must be absolute or 'auto', got: ${value}`];
                }
            }
            saveUserCfg({ workspace: { path: value } });
            return [true, `workspace.path → ${value}`];
        }
        return [false, `unknown workspace key: ${parts[1]}`];
    }
    if (parts.length === 2 && parts[0] === 'model') {
        const agentName = parts[1];
        if (!AGENT_NAMES.includes(agentName)) {
            return [false, `unknown agent '${agentName}', use: model.${AGENT_NAMES.join(', model.')}`];
        }
        saveUserCfg({ agents: { [agentName]: { model: value } } });
        return [true, `${agentName} model → ${value}`];
    }
    if (parts.length === 2 && parts[0] === 'cli' && parts[1] === 'default_agent') {
        if (!AGENT_NAMES.includes(value.toLowerCase())) {
            return [false, `invalid agent '${value}', use one of: ${AGENT_NAMES.join(', ')}`];
        }
        saveUserCfg({ cli: { default_agent: value.toLowerCase() } });
        return [true, `default_agent → ${value}`];
    }
    if (parts.length === 2 && parts[0] === 'tts') {
        if (parts[1] === 'api_key') {
            saveUserCfg({ tts: { api_key: value, enabled: true } });
            return [true, 'tts.api_key saved (TTS enabled)'];
        }
        if (parts[1] === 'voice_type') {
            saveUserCfg({ tts: { voice_type: value } });
            return [true, `tts.voice_type → ${value}`];
        }
        return [false, `unknown tts key: ${parts[1]}`];
    }
    if (SIMPLE_LLM_KEYS.includes(key)) {
        let typedVal = value;
        if (key === 'temperature') {
            typedVal = Number(value);
            if (Number.isNaN(typedVal))
                return [false, `invalid value for ${key}: '${value}'`];
            if (!(typedVal >= 0.0 && typedVal <= 2.0))
                return [false, 'temperature must be in [0.0, 2.0]'];
        }
        else if (key === 'max_tokens') {
            typedVal = Number(value);
            if (!Number.isInteger(typedVal))
                return [false, `invalid value for ${key}: '${value}'`];
            if (!(typedVal >= 1 && typedVal <= 200000))
                return [false, 'max_tokens must be in [1, 200000]'];
        }
        else if (key === 'timeout') {
            typedVal = Number(value);
            if (!Number.isInteger(typedVal))
                return [false, `invalid value for ${key}: '${value}'`];
            if (!(typedVal >= 1 && typedVal <= 600))
                return [false, 'timeout must be in [1, 600] seconds'];
        }
        saveUserCfg({ llm: { [key]: typedVal } });
        return [true, `${key} → ${value}`];
    }
    return [false, `unknown config key: ${key}`];
}
/** Delete a config key from user config. Returns [ok, message]. */
export function deleteConfig(key) {
    const path = join(USER_CONFIG_DIR, 'config.yaml');
    const data = loadYaml(path);
    if (!data || Object.keys(data).length === 0) {
        return [true, 'nothing to delete (config is empty)'];
    }
    const parts = key.split('.');
    const popKey = (obj, k) => {
        if (obj && k in obj) {
            delete obj[k];
            return true;
        }
        return false;
    };
    if (parts.length === 2 && parts[0] === 'api_key') {
        const provider = parts[1];
        const removed = popKey(data.llm?.api_keys, provider);
        if (removed)
            writeYaml(path, data);
        const envVar = ENV_KEY_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`;
        delete process.env[envVar];
        return [true, removed ? `api_key.${provider} deleted` : `api_key.${provider} not set`];
    }
    if (parts.length === 2 && parts[0] === 'workspace' && parts[1] === 'path') {
        const removed = popKey(data.workspace, 'path');
        if (removed) {
            writeYaml(path, data);
            return [true, 'workspace.path reset to auto'];
        }
        return [true, 'workspace.path already at auto'];
    }
    if (parts.length === 2 && parts[0] === 'model') {
        const agentName = parts[1];
        if (!AGENT_NAMES.includes(agentName)) {
            return [false, 'unknown agent'];
        }
        const removed = popKey(data.agents?.[agentName], 'model');
        if (removed) {
            writeYaml(path, data);
            return [true, `${agentName} model reset to default`];
        }
        return [true, `${agentName} already using default`];
    }
    if (parts.length === 2 && parts[0] === 'cli' && parts[1] === 'default_agent') {
        const removed = popKey(data.cli, 'default_agent');
        if (removed) {
            writeYaml(path, data);
            return [true, 'default_agent reset to fog'];
        }
        return [true, 'default_agent already at fog'];
    }
    if (SIMPLE_LLM_KEYS.includes(key)) {
        const removed = popKey(data.llm, key);
        if (removed) {
            writeYaml(path, data);
            return [true, `${key} reset to default`];
        }
        return [true, `${key} already at default`];
    }
    return [false, `unknown config key: ${key}`];
}
