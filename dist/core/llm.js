/**
 * LLM abstraction layer with retry, fallback, cost tracking, and budget control.
 *
 * The Python original wraps LiteLLM; this port wraps the Vercel AI SDK
 * (`ai` + `@ai-sdk/*`). The provider call is isolated behind `CompletionBackend`
 * so all orchestration logic (fallback chains, retries, usage/cost tracking,
 * budget, caching, user-facing error formatting) is provider-agnostic and unit
 * testable with a fake backend — mirroring how the Python tests mock litellm.
 */
import { LLMCache } from './cache.js';
import { loadProviderCatalog, getProviderEnvVar } from './config.js';
import { getLogger, logEvent } from './logger.js';
const log = getLogger('llm');
// ── Provider routing ─────────────────────────────────────────────────────────
function buildKnownProviders() {
    try {
        const cat = loadProviderCatalog();
        const known = new Set();
        for (const [provider, entry] of Object.entries(cat)) {
            known.add(provider.toLowerCase());
            for (const alias of entry.aliases ?? []) {
                if (typeof alias === 'string')
                    known.add(alias.toLowerCase());
            }
        }
        if (known.size)
            return known;
    }
    catch {
        /* fall through */
    }
    return new Set([
        'openai',
        'azure',
        'anthropic',
        'deepseek',
        'ollama',
        'groq',
        'mistral',
        'cohere',
        'together_ai',
        'openrouter',
        'gemini',
        'vertex_ai',
    ]);
}
const KNOWN_PROVIDERS = buildKnownProviders();
/** Return [provider, strippedModel] if model looks like `<provider>/<name>`. */
export function splitProvider(model) {
    if (!model.includes('/'))
        return [null, model];
    const idx = model.indexOf('/');
    const head = model.slice(0, idx);
    const tail = model.slice(idx + 1);
    if (KNOWN_PROVIDERS.has(head.toLowerCase()))
        return [head.toLowerCase(), tail];
    return [null, model];
}
/** True when the model targets Anthropic's API. */
export function isAnthropicModel(model) {
    const lowered = model.toLowerCase();
    if (lowered.startsWith('anthropic/') || lowered.startsWith('claude'))
        return true;
    return splitProvider(model)[0] === 'anthropic';
}
function buildProviderEnvMap() {
    try {
        const cat = loadProviderCatalog();
        const out = {};
        for (const [provider, entry] of Object.entries(cat)) {
            const env = entry.env_var;
            if (typeof env === 'string' && env)
                out[provider.toLowerCase()] = env;
            for (const alias of entry.aliases ?? []) {
                if (typeof alias === 'string' && typeof env === 'string' && env) {
                    out[alias.toLowerCase()] = env;
                }
            }
        }
        if (Object.keys(out).length)
            return out;
    }
    catch {
        /* fall through */
    }
    return {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        groq: 'GROQ_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        cohere: 'COHERE_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        gemini: 'GEMINI_API_KEY',
    };
}
const PROVIDER_ENV = buildProviderEnvMap();
// ── User-facing error formatting ───────────────────────────────────────────
export function formatUserFacingError(model, err) {
    const text = err ? (err instanceof Error ? err.message : String(err)) : 'unknown error';
    const [provider] = splitProvider(model);
    const lowered = text.toLowerCase();
    if (lowered.includes('api_key') ||
        lowered.includes('authentication') ||
        lowered.includes('unauthorized')) {
        const envVar = PROVIDER_ENV[provider ?? ''] ?? 'the appropriate *_API_KEY';
        const configured = Object.entries(PROVIDER_ENV)
            .filter(([, e]) => process.env[e])
            .map(([p]) => p);
        const hint = configured.length ? `已配置: ${configured.join(', ')}。` : '未配置任何 API key。';
        return `❌  ${model} 调用失败：缺少或无效的 API key。\n请确认 \`${envVar}\` 已设置，或运行 \`wa init\` 重新配置。${hint}`;
    }
    if (lowered.includes('rate limit') || text.includes('429')) {
        return `❌  ${model} 速率受限，请稍后重试。`;
    }
    if (lowered.includes('timeout')) {
        return `❌  ${model} 请求超时，请稍后重试或调高 \`wa config set timeout 180\`。`;
    }
    if (lowered.includes('model') &&
        (lowered.includes('not found') || lowered.includes('does not exist'))) {
        return `❌  ${model} 不是该 provider 的有效模型 ID。\n运行 \`wa config models\` 查看可用模型，或 \`wa init\` 重新选择。`;
    }
    const safetyKw = [
        'content exists risk',
        'content_policy',
        'content_filter',
        'content_filtered',
        'safety',
        'blocked by safety',
        'responsibleaipolicyviolation',
        'policy_violation',
    ];
    if (safetyKw.some((kw) => lowered.includes(kw))) {
        const short = text.split('\n')[0].slice(0, 200);
        return (`❌  ${model} 拒绝该请求 (内容审核)：${short}\n` +
            `原因：provider 的内容安全过滤判定此次提问/上下文敏感。\n` +
            `建议：\n` +
            `  - 换一个 provider（如 OpenAI / Anthropic / 本地 Ollama）：\`/model\` 切换\n` +
            `  - 把敏感关键词改写得更通用后重发\n` +
            `  - \`/memory clear\` 仅在你确认是上下文里某条历史消息触发审核时使用`);
    }
    const errName = err && err instanceof Error ? err.constructor.name.toLowerCase() : '';
    const badReqKw = ['bad request', 'invalid_request', 'tool_calls', 'tool messages'];
    if (badReqKw.some((kw) => lowered.includes(kw)) || errName.includes('badrequest')) {
        const short = text.split('\n')[0].slice(0, 200);
        return `❌  ${model} 调用失败 (Bad Request)：${short}\n会话消息序列可能损坏，可运行 \`wa memory clear\` 清理后重试。`;
    }
    const short = text && text.trim() ? text.split('\n')[0].slice(0, 200) : (err?.constructor?.name ?? 'Error');
    return `❌  ${model} 调用失败：${short}`;
}
// ── Token / cost estimation ─────────────────────────────────────────────────
export function estimateTokens(text) {
    let cjk = 0;
    for (const c of text) {
        const cp = c.codePointAt(0);
        if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f))
            cjk += 1;
    }
    const other = text.length - cjk;
    return Math.max(1, cjk * 2 + Math.floor(other / 4));
}
// Cost per 1K tokens (input / output) — USD.
const MODEL_COST_ESTIMATES = {
    'gpt-4o': [0.0025, 0.01],
    'gpt-4o-mini': [0.00015, 0.0006],
    'gpt-4.1': [0.002, 0.008],
    'gpt-4.1-mini': [0.0004, 0.0016],
    'gpt-4.1-nano': [0.0001, 0.0004],
    o3: [0.01, 0.04],
    'o4-mini': [0.0011, 0.0044],
    'claude-sonnet-4-6': [0.003, 0.015],
    'claude-opus-4-7': [0.005, 0.025],
    'claude-haiku-4-5': [0.0008, 0.004],
    'deepseek-v4-flash': [0.00014, 0.00028],
    'deepseek-v4-pro': [0.00174, 0.00348],
    'deepseek/deepseek-v4-flash': [0.00014, 0.00028],
    'deepseek/deepseek-v4-pro': [0.00174, 0.00348],
    'gemini/gemini-2.5-flash': [0.0003, 0.0025],
    'gemini/gemini-2.5-pro': [0.00125, 0.01],
    'ollama/llama3': [0.0, 0.0],
    'ollama/qwen2.5': [0.0, 0.0],
};
export const FALLBACK_CHAINS = {
    'gpt-4o': ['gpt-4o-mini'],
    'gpt-4o-mini': ['gpt-4o'],
    'gpt-4.1': ['gpt-4.1-mini', 'gpt-4o-mini'],
    'gpt-4.1-mini': ['gpt-4o-mini'],
    'gpt-4.1-nano': ['gpt-4.1-mini'],
    o3: ['o4-mini', 'gpt-4.1'],
    'o4-mini': ['gpt-4.1-mini'],
    'claude-sonnet-4-6': ['claude-haiku-4-5', 'gpt-4.1-mini'],
    'claude-opus-4-7': ['claude-sonnet-4-6', 'gpt-4.1'],
    'claude-haiku-4-5': ['gpt-4.1-mini'],
    'deepseek-v4-flash': ['gpt-4.1-mini'],
    'deepseek-v4-pro': ['deepseek-v4-flash', 'gpt-4.1-mini'],
    'deepseek/deepseek-v4-flash': ['gpt-4.1-mini'],
    'deepseek/deepseek-v4-pro': ['deepseek/deepseek-v4-flash', 'gpt-4.1-mini'],
    'gemini/gemini-2.5-flash': ['gemini/gemini-2.5-pro', 'gpt-4.1-mini'],
    'gemini/gemini-2.5-pro': ['gpt-4.1'],
};
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export function isTransientError(exc) {
    const e = exc;
    const status = e?.statusCode ?? e?.status ?? 0;
    if (status && RETRYABLE_STATUSES.has(status))
        return true;
    const name = exc instanceof Error ? exc.constructor.name : '';
    return [
        'RateLimitError',
        'APITimeoutError',
        'APIConnectionError',
        'ServiceUnavailableError',
        'InternalServerError',
        'Timeout',
        'TimeoutError',
    ].includes(name);
}
export function estimateCost(model, promptTokens, completionTokens) {
    const costs = MODEL_COST_ESTIMATES[model] ?? [0.001, 0.002];
    return (promptTokens / 1000) * costs[0] + (completionTokens / 1000) * costs[1];
}
export class LLMClient {
    config;
    toolRegistry;
    cache;
    backend;
    usageStats = {};
    totalCost = 0;
    costLimit;
    constructor(config, toolRegistry, opts = {}) {
        this.config = config;
        this.toolRegistry = toolRegistry;
        this.cache = new LLMCache(256, 120);
        this.costLimit = opts.costLimit ?? null;
        this.backend = opts.backend ?? new AiSdkBackend();
    }
    getModel(agentName = null) {
        if (agentName) {
            const agentCfg = this.config.agents[agentName];
            if (agentCfg && agentCfg.model)
                return agentCfg.model;
        }
        return this.config.llm.defaultModel;
    }
    getRetries() {
        return this.config.llm.maxRetries ?? 2;
    }
    trackUsage(agentName, model, promptTokens, completionTokens) {
        const key = agentName || 'default';
        const s = (this.usageStats[key] ??= {
            prompt_tokens: 0,
            completion_tokens: 0,
            calls: 0,
            cost: 0,
        });
        s.prompt_tokens += promptTokens;
        s.completion_tokens += completionTokens;
        s.calls += 1;
        const cost = estimateCost(model, promptTokens, completionTokens);
        s.cost += cost;
        this.totalCost += cost;
    }
    getUsageStats() {
        return { ...this.usageStats };
    }
    getTotalCost() {
        return this.totalCost;
    }
    resetUsageStats() {
        this.usageStats = {};
        this.totalCost = 0;
    }
    checkBudget() {
        if (this.costLimit !== null && this.totalCost >= this.costLimit) {
            throw new Error(`Cost limit exceeded: $${this.totalCost.toFixed(4)} >= $${this.costLimit.toFixed(4)}`);
        }
    }
    hasKeyForModel(model) {
        let [provider] = splitProvider(model);
        if (provider === null) {
            const lowered = model.toLowerCase();
            for (const p of KNOWN_PROVIDERS) {
                if (lowered.includes(p)) {
                    provider = p;
                    break;
                }
            }
        }
        if (provider === null)
            return true; // can't determine; don't skip
        const envVar = PROVIDER_ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`;
        return Boolean(process.env[envVar]);
    }
    async complete(messages, opts = {}) {
        this.checkBudget();
        const { agentName = null, tools = null, stream = false, overrides = null } = opts;
        const ov = overrides ?? {};
        const model = typeof ov.model === 'string' ? ov.model : this.getModel(agentName);
        const fallbackModels = (FALLBACK_CHAINS[model] ?? []).filter((m) => this.hasKeyForModel(m));
        const modelsToTry = [model, ...fallbackModels];
        let primaryError = null;
        for (let i = 0; i < modelsToTry.length; i++) {
            const attemptModel = modelsToTry[i];
            try {
                this.checkBudget();
                return await this.completeWithRetry(attemptModel, messages, agentName, tools, stream, ov);
            }
            catch (e) {
                if (i === 0)
                    primaryError = e;
                log.warning('llm_fallback', { model: attemptModel, agent: agentName, error: String(e) });
            }
        }
        log.error('llm_all_failed', {
            models: modelsToTry,
            agent: agentName,
            error: String(primaryError),
        });
        return this.errorResponse(model, formatUserFacingError(model, primaryError));
    }
    errorResponse(model, content) {
        return {
            content,
            toolCalls: [],
            model,
            usage: {},
            cost: 0,
            reasoningContent: null,
            truncated: false,
        };
    }
    async completeWithRetry(model, messages, agentName, tools, stream, ov) {
        const toolSchemas = tools ? this.toolRegistry.getSchemas(tools) : null;
        const temperature = ov.temperature ?? this.config.llm.temperature;
        const maxTokens = ov.max_tokens ?? this.config.llm.maxTokens;
        const cacheParams = { temperature, max_tokens: maxTokens };
        const useCache = !tools && !stream;
        if (useCache) {
            const cached = this.cache.get(model, messages, cacheParams);
            if (cached !== null) {
                logEvent(log, 'cache_hit', { model, agent: agentName });
                return this.errorResponse(model, cached); // shape reuse: content=cached, no tools
            }
        }
        const maxRetries = this.getRetries();
        const [provider, strippedModel] = splitProvider(model);
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const start = performance.now();
                const raw = await this.backend.complete({
                    model,
                    provider,
                    strippedModel,
                    messages,
                    tools: toolSchemas,
                    temperature,
                    maxTokens,
                    timeout: this.config.llm.timeout,
                });
                const elapsed = performance.now() - start;
                const actualModel = raw.model || model;
                this.trackUsage(agentName, actualModel, raw.promptTokens, raw.completionTokens);
                logEvent(log, 'llm_call', {
                    model: actualModel,
                    agent: agentName,
                    prompt_tokens: raw.promptTokens,
                    completion_tokens: raw.completionTokens,
                    duration_ms: Math.round(elapsed),
                    tool_calls: raw.toolCalls.length,
                });
                if (useCache && raw.content && raw.toolCalls.length === 0) {
                    this.cache.set(model, messages, raw.content, cacheParams);
                }
                return {
                    content: raw.content,
                    toolCalls: raw.toolCalls,
                    model: actualModel,
                    usage: { prompt_tokens: raw.promptTokens, completion_tokens: raw.completionTokens },
                    cost: estimateCost(actualModel, raw.promptTokens, raw.completionTokens),
                    reasoningContent: raw.reasoningContent,
                    truncated: false,
                };
            }
            catch (e) {
                lastError = e;
                if (isTransientError(e) && attempt < maxRetries) {
                    const delay = Math.min(2 ** attempt * 1.0, 10.0);
                    log.warning('llm_retry', {
                        model,
                        agent: agentName,
                        attempt: attempt + 1,
                        delay,
                        error: String(e),
                    });
                    await new Promise((r) => setTimeout(r, delay * 1000));
                }
                else {
                    throw e;
                }
            }
        }
        throw lastError;
    }
    /** Plain text streaming (no tools). */
    async *stream(messages, agentName = null) {
        this.checkBudget();
        const model = this.getModel(agentName);
        const [provider, strippedModel] = splitProvider(model);
        let fullContent = '';
        const start = performance.now();
        try {
            for await (const chunk of this.backend.stream({
                model,
                provider,
                strippedModel,
                messages,
                tools: null,
                temperature: this.config.llm.temperature,
                maxTokens: this.config.llm.maxTokens,
                timeout: this.config.llm.timeout,
            })) {
                if (chunk.kind === 'content') {
                    fullContent += chunk.text;
                    yield chunk.text;
                }
            }
            const elapsed = performance.now() - start;
            const promptTokens = Math.max(1, estimateTokens(JSON.stringify(messages)));
            const completionTokens = Math.max(1, estimateTokens(fullContent));
            this.trackUsage(agentName, model, promptTokens, completionTokens);
            logEvent(log, 'llm_stream', {
                model,
                agent: agentName,
                duration_ms: Math.round(elapsed),
                chars: fullContent.length,
            });
        }
        catch (e) {
            yield `\n[Stream error: ${e instanceof Error ? e.message : String(e)}]`;
        }
    }
    /**
     * Stream completion with tool-call awareness.
     *
     * Fallback chains apply only BEFORE the first chunk — once content has
     * streamed we commit to the model; later errors become terminal "error"
     * events. Tool calls are emitted fully-accumulated after the stream ends
     * (arguments arrive across chunks).
     */
    async *streamWithTools(messages, opts = {}) {
        this.checkBudget();
        const { agentName = null, tools = null, toolRegistry = null, overrides = null } = opts;
        const ov = overrides ?? {};
        const primaryModel = typeof ov.model === 'string' ? ov.model : this.getModel(agentName);
        const fallbackModels = (FALLBACK_CHAINS[primaryModel] ?? []).filter((m) => this.hasKeyForModel(m));
        const modelsToTry = [primaryModel, ...fallbackModels];
        const reg = toolRegistry ?? this.toolRegistry;
        const toolSchemas = tools && reg ? reg.getSchemas(tools) : null;
        // Phase A: establish a stream against each model in turn.
        let iterator = null;
        let usedModel = primaryModel;
        let primaryError = null;
        for (let i = 0; i < modelsToTry.length; i++) {
            const attemptModel = modelsToTry[i];
            const [ap, stripped] = splitProvider(attemptModel);
            try {
                iterator = this.backend.stream({
                    model: attemptModel,
                    provider: ap,
                    strippedModel: stripped,
                    messages,
                    tools: toolSchemas,
                    temperature: ov.temperature ?? this.config.llm.temperature,
                    maxTokens: ov.max_tokens ?? this.config.llm.maxTokens,
                    timeout: this.config.llm.timeout,
                });
                usedModel = attemptModel;
                break;
            }
            catch (e) {
                if (i === 0)
                    primaryError = e;
                log.warning('stream_fallback', { model: attemptModel, agent: agentName, error: String(e) });
            }
        }
        if (iterator === null) {
            yield this.streamEvent('error', { text: formatUserFacingError(primaryModel, primaryError) });
            return;
        }
        const model = usedModel;
        let fullContent = '';
        let reasoningContent = null;
        const toolCallAcc = new Map();
        let backendPromptTokens = 0;
        let backendCompletionTokens = 0;
        const start = performance.now();
        try {
            let toolIdx = 0;
            for await (const chunk of iterator) {
                if (chunk.kind === 'content') {
                    fullContent += chunk.text;
                    yield this.streamEvent('content', { text: chunk.text });
                }
                else if (chunk.kind === 'reasoning') {
                    reasoningContent = (reasoningContent ?? '') + chunk.text;
                    yield this.streamEvent('reasoning', { text: chunk.text });
                }
                else if (chunk.kind === 'tool_call') {
                    // Backend yields fully-formed tool calls; accumulate in arrival order.
                    toolCallAcc.set(toolIdx++, chunk.toolCall);
                }
                else if (chunk.kind === 'usage') {
                    backendPromptTokens = chunk.promptTokens;
                    backendCompletionTokens = chunk.completionTokens;
                }
            }
        }
        catch (e) {
            yield this.streamEvent('error', { text: formatUserFacingError(model, e) });
            return;
        }
        for (const idx of [...toolCallAcc.keys()].sort((a, b) => a - b)) {
            const tc = toolCallAcc.get(idx);
            if (tc.id && tc.function.name) {
                yield this.streamEvent('tool_call', { toolCall: tc });
            }
        }
        const elapsed = performance.now() - start;
        const promptTokens = backendPromptTokens || Math.max(1, Math.floor(JSON.stringify(messages).length / 4));
        const completionTokens = backendCompletionTokens || Math.max(1, Math.floor(fullContent.length / 4));
        this.trackUsage(agentName, model, promptTokens, completionTokens);
        logEvent(log, 'llm_stream', {
            model,
            agent: agentName,
            duration_ms: Math.round(elapsed),
            chars: fullContent.length,
        });
        yield this.streamEvent('done', {
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            reasoningContent,
        });
    }
    streamEvent(type, parts = {}) {
        return {
            type,
            text: parts.text ?? '',
            toolCall: parts.toolCall ?? null,
            usage: parts.usage ?? null,
            reasoningContent: parts.reasoningContent ?? null,
        };
    }
}
// ── Default backend: Vercel AI SDK ───────────────────────────────────────────
//
// INTEGRATION SEAM. The orchestration above is fully unit-tested with a fake
// backend; this adapter wires the real `ai` SDK and needs live verification
// against each provider. It maps our OpenAI-style messages/tool schemas to the
// AI SDK's CoreMessage / jsonSchema tool shapes and back.
function safeJsonObject(raw) {
    if (raw && typeof raw === 'object')
        return raw;
    if (typeof raw === 'string') {
        try {
            const v = JSON.parse(raw);
            return v && typeof v === 'object' ? v : {};
        }
        catch {
            return {};
        }
    }
    return {};
}
/**
 * Convert OpenAI-style messages (role + content + tool_calls/tool_call_id) into
 * Vercel AI SDK CoreMessage[]. Assistant tool calls become `tool-call` parts;
 * `role:'tool'` results become `tool-result` parts (toolName recovered from the
 * matching preceding assistant tool_call id, which the SDK requires). Without
 * this, multi-turn tool conversations are malformed for the SDK.
 */
export function toCoreMessages(messages) {
    const idToName = new Map();
    // First pass: map every tool_call id → toolName.
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc?.id && tc?.function?.name)
                    idToName.set(tc.id, tc.function.name);
            }
        }
    }
    const out = [];
    for (const m of messages) {
        if (m.role === 'system' || m.role === 'user') {
            out.push({ role: m.role, content: String(m.content ?? '') });
        }
        else if (m.role === 'assistant') {
            if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
                const parts = [];
                if (m.content)
                    parts.push({ type: 'text', text: String(m.content) });
                for (const tc of m.tool_calls) {
                    parts.push({
                        type: 'tool-call',
                        toolCallId: tc.id,
                        toolName: tc.function?.name ?? 'unknown',
                        args: safeJsonObject(tc.function?.arguments),
                    });
                }
                out.push({ role: 'assistant', content: parts });
            }
            else {
                out.push({ role: 'assistant', content: String(m.content ?? '') });
            }
        }
        else if (m.role === 'tool') {
            out.push({
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: m.tool_call_id,
                        toolName: idToName.get(m.tool_call_id) ?? m.name ?? 'unknown',
                        result: String(m.content ?? ''),
                    },
                ],
            });
        }
        else {
            // Unknown role — pass content through as a user message (defensive).
            out.push({ role: 'user', content: String(m.content ?? '') });
        }
    }
    return out;
}
export class AiSdkBackend {
    async makeModel(req) {
        const provider = req.provider ?? 'openai';
        const modelName = req.strippedModel;
        const envVar = getProviderEnvVar(provider);
        const apiKey = process.env[envVar];
        if (provider === 'anthropic') {
            const { createAnthropic } = await import('@ai-sdk/anthropic');
            return createAnthropic({ apiKey })(modelName);
        }
        if (provider === 'gemini' || provider === 'google' || provider === 'google_gemini') {
            const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
            return createGoogleGenerativeAI({ apiKey })(modelName);
        }
        // openai + every OpenAI-compatible provider (deepseek, ollama, groq,
        // openrouter, mistral, together_ai, ...). base_url comes from the catalog.
        const { createOpenAI } = await import('@ai-sdk/openai');
        let baseURL;
        try {
            const entry = loadProviderCatalog()[provider];
            const bu = entry?.base_url;
            if (typeof bu === 'string' && bu)
                baseURL = bu;
        }
        catch {
            /* default openai endpoint */
        }
        return createOpenAI({ apiKey, baseURL })(modelName);
    }
    async buildTools(schemas) {
        if (!schemas || schemas.length === 0)
            return undefined;
        const { jsonSchema, tool } = await import('ai');
        const out = {};
        for (const s of schemas) {
            out[s.function.name] = tool({
                description: s.function.description,
                parameters: jsonSchema(s.function.parameters),
                // No `execute`: the agent loop runs tools and feeds results back, so
                // the SDK only needs to surface the tool call.
            });
        }
        return out;
    }
    async complete(req) {
        const { generateText } = await import('ai');
        const model = await this.makeModel(req);
        const result = await generateText({
            model,
            messages: toCoreMessages(req.messages),
            tools: await this.buildTools(req.tools),
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            abortSignal: AbortSignal.timeout(req.timeout * 1000),
        });
        const toolCalls = (result.toolCalls ?? []).map((tc) => ({
            id: tc.toolCallId,
            type: 'function',
            function: { name: tc.toolName, arguments: JSON.stringify(tc.args ?? {}) },
        }));
        return {
            content: result.text ?? '',
            toolCalls,
            reasoningContent: result.reasoning ?? null,
            promptTokens: result.usage?.promptTokens ?? 0,
            completionTokens: result.usage?.completionTokens ?? 0,
            model: req.model,
        };
    }
    async *stream(req) {
        const { streamText } = await import('ai');
        const model = await this.makeModel(req);
        const result = streamText({
            model,
            messages: toCoreMessages(req.messages),
            tools: await this.buildTools(req.tools),
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            abortSignal: AbortSignal.timeout(req.timeout * 1000),
        });
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'text-delta':
                    yield { kind: 'content', text: part.textDelta };
                    break;
                case 'reasoning':
                    yield { kind: 'reasoning', text: part.textDelta };
                    break;
                case 'tool-call':
                    yield {
                        kind: 'tool_call',
                        toolCall: {
                            id: part.toolCallId,
                            type: 'function',
                            function: { name: part.toolName, arguments: JSON.stringify(part.args ?? {}) },
                        },
                    };
                    break;
                case 'finish':
                    yield {
                        kind: 'usage',
                        promptTokens: part.usage?.promptTokens ?? 0,
                        completionTokens: part.usage?.completionTokens ?? 0,
                    };
                    break;
                case 'error':
                    throw part.error instanceof Error ? part.error : new Error(String(part.error));
            }
        }
    }
}
//# sourceMappingURL=llm.js.map