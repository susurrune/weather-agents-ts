/** MCP (Model Context Protocol) client — Anthropic-compatible transport.
 *
 * Implements the MCP 2025-03-26 specification with two transports:
 * - stdio: subprocess-based JSON-RPC over stdin/stdout
 * - SSE: text/event-stream via fetch with jsonrpc POST endpoint
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getLogger } from './logger.js';
import { Tool } from './tool.js';
const log = getLogger('mcp');
const MCP_PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'weather-agents', version: '1.0.0' };
// ── MCPClient (single server) ────────────────────────────────────────────
export class MCPClient {
    config;
    process = null;
    serverTools = [];
    nextId = 0;
    pending = new Map();
    readerTask = null;
    responseLineBuffer = '';
    responseResolver = null;
    // SSE state
    sseAbortController = null;
    sseMessageEndpoint = null;
    constructor(config) {
        this.config = { args: [], env: {}, enabled: true, ...config };
    }
    newId() {
        this.nextId += 1;
        return this.nextId;
    }
    // ── Public API ───────────────────────────────────────────────────────
    async initialize() {
        try {
            if (this.config.command)
                return await this.initStdio();
            if (this.config.url)
                return await this.initSse();
        }
        catch (e) {
            log.warning('mcp_server_unavailable', { server: this.config.name, error: String(e) });
        }
        return [];
    }
    async healthCheck() {
        if (this.config.command)
            return this.healthStdio();
        if (this.config.url)
            return this.healthSse();
        return { healthy: false, details: 'No transport configured' };
    }
    async close() {
        // Cancel SSE first
        try {
            this.sseAbortController?.abort();
        }
        catch {
            /* noop */
        }
        // Reject all pending
        for (const [, p] of this.pending)
            p.reject(new Error('Connection closed'));
        this.pending.clear();
        // Kill subprocess
        if (this.process && !this.process.killed) {
            try {
                this.process.kill();
            }
            catch {
                /* noop */
            }
        }
        this.process = null;
        this.readerTask = null;
        this.serverTools = [];
    }
    // ── stdio transport ──────────────────────────────────────────────────
    async initStdio() {
        const cmd = this.config.command;
        if (!cmd)
            return [];
        const env = { ...process.env, ...(this.config.env || {}) };
        this.process = spawn(cmd, this.config.args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        // Setup response reader
        this.setupStdioReader();
        // Drain stderr (prevent buffer blocks)
        this.drainStderr();
        try {
            const initResp = await this.requestStdio('initialize', {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: CLIENT_INFO,
            });
            if (!initResp || initResp.error)
                return [];
            await this.sendJson({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
            const toolsResp = await this.requestStdio('tools/list', {});
            if (toolsResp?.result) {
                this.serverTools = toolsResp.result.tools || [];
            }
            return this.serverTools;
        }
        catch (e) {
            log.warning('mcp_stdio_init_failed', { server: this.config.name, error: String(e) });
            await this.close();
            return [];
        }
    }
    setupStdioReader() {
        if (!this.process?.stdout)
            return;
        const rl = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
        rl.on('line', (line) => {
            try {
                const msg = JSON.parse(line.trim());
                if (msg?.id !== undefined && msg?.id !== null) {
                    const p = this.pending.get(msg.id);
                    if (p) {
                        this.pending.delete(msg.id);
                        p.resolve(msg);
                    }
                }
            }
            catch {
                // Skip non-JSON lines (stderr noise, protocol logs)
            }
        });
        rl.on('close', () => {
            for (const [, p] of this.pending)
                p.reject(new Error('stdio stream closed'));
            this.pending.clear();
        });
        this.readerTask = new Promise(() => { }); // keep-alive marker
    }
    drainStderr() {
        if (!this.process?.stderr)
            return;
        const rl = createInterface({ input: this.process.stderr, crlfDelay: Infinity });
        rl.on('line', (line) => {
            log.debug('mcp_stderr', { server: this.config.name, line: line.slice(0, 200) });
        });
    }
    sendJson(msg) {
        if (!this.process?.stdin || this.process.killed)
            return;
        this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
    requestStdio(method, params, timeout = 10.0) {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin || this.process.killed) {
                return resolve(null);
            }
            const id = this.newId();
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timeout waiting for '${method}' response`));
            }, timeout * 1000);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            this.sendJson({ jsonrpc: '2.0', id, method, params });
        });
    }
    healthStdio() {
        if (!this.process || this.process.exitCode !== null || this.process.killed) {
            return { healthy: false, details: 'stdio process not running' };
        }
        this.requestStdio('ping', {}, 5.0)
            .then((r) => (r?.result ? null : null))
            .catch(() => null);
        return { healthy: true, details: 'ok' };
    }
    /**
     * Call a tool on this server via tools/call (transport-agnostic). Returns the
     * extracted text content, or a JSON-stringified fallback. Public so the
     * manager doesn't reach into private transport methods.
     */
    async callTool(name, args, timeout = 30.0) {
        const resp = this.config.url
            ? await this.requestSse('tools/call', { name, arguments: args }, timeout)
            : await this.requestStdio('tools/call', { name, arguments: args }, timeout);
        const text = resp?.result?.content?.[0]?.text;
        if (typeof text === 'string')
            return text;
        return JSON.stringify(resp?.result ?? resp?.error ?? 'no response');
    }
    // ── SSE transport ────────────────────────────────────────────────────
    async initSse() {
        try {
            const url = this.config.url;
            if (!url)
                return [];
            // Step 1: establish SSE stream
            this.sseAbortController = new AbortController();
            const sseRes = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'text/event-stream' },
                signal: this.sseAbortController.signal,
            });
            // Step 2: read the endpoint event to get the message POST URL
            const sseText = await sseRes.text();
            for (const line of sseText.split('\n')) {
                if (line.startsWith('data: ')) {
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (d?.endpoint)
                            this.sseMessageEndpoint = d.endpoint;
                    }
                    catch {
                        /* skip */
                    }
                }
            }
            if (!this.sseMessageEndpoint) {
                log.warning('mcp_sse_no_endpoint', { server: this.config.name });
                return [];
            }
            // Step 3: initialize via JSON-RPC POST
            const initResp = await this.requestSse('initialize', {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: CLIENT_INFO,
            });
            if (!initResp || initResp.error)
                return [];
            await this.requestSse('notifications/initialized', {});
            const toolsResp = await this.requestSse('tools/list', {});
            if (toolsResp?.result) {
                this.serverTools = toolsResp.result.tools || [];
            }
            return this.serverTools;
        }
        catch (e) {
            log.warning('mcp_sse_init_failed', { server: this.config.name, error: String(e) });
            return [];
        }
    }
    async requestSse(method, params, timeout = 10.0) {
        if (!this.sseMessageEndpoint)
            return null;
        const id = this.newId();
        const endpoint = this.sseMessageEndpoint;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout * 1000);
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                signal: ac.signal,
            });
            const d = await res.json().catch(() => null);
            return d;
        }
        catch {
            return { error: 'SSE request failed or timed out' };
        }
        finally {
            clearTimeout(timer);
        }
    }
    healthSse() {
        if (!this.sseMessageEndpoint)
            return { healthy: false, details: 'No SSE message endpoint' };
        return { healthy: true, details: 'ok' };
    }
}
// ── MCPManager (multi-server registry) ────────────────────────────────
export class MCPManager {
    clients = [];
    toolRegistry;
    constructor(toolRegistry) {
        this.toolRegistry = toolRegistry;
    }
    configure(servers) {
        for (const sc of servers) {
            if (sc.enabled !== false && (sc.command || sc.url)) {
                this.clients.push(new MCPClient(sc));
            }
        }
    }
    async connectAll() {
        const status = [];
        for (const client of this.clients) {
            try {
                const tools = await client.initialize();
                if (tools.length) {
                    // Register MCP-discovered tools into the tool registry
                    for (const t of tools) {
                        this.registerMcpTool(client.config.name, t);
                    }
                    status.push(`${client.config.name} (${tools.length} tools)`);
                    log.info('mcp_connected', { server: client.config.name, tool_count: tools.length });
                }
            }
            catch (e) {
                log.warning('mcp_connect_failed', { server: client.config.name, error: String(e) });
                status.push(`${client.config.name} (failed)`);
            }
        }
        return status;
    }
    async closeAll() {
        await Promise.all(this.clients.map((c) => c.close()));
        this.clients.length = 0;
    }
    registerMcpTool(serverName, toolInfo) {
        // Map MCP JSON Schema (inputSchema) to our ToolParameter format
        const inputSchema = toolInfo.inputSchema ?? {};
        const properties = inputSchema.properties ?? {};
        const required = inputSchema.required ?? [];
        const parameters = [];
        for (const [name, prop] of Object.entries(properties)) {
            const p = prop;
            parameters.push({
                name,
                type: p.type ?? 'string',
                description: p.description ?? '',
                required: required.includes(name),
                default: p.default,
            });
        }
        // MCP tools are registered as remote stubs: the handler delegates back
        // to the MCP server's tools/call endpoint. The Tool.execute path will
        // call this handler when the LLM invokes the tool.
        const client = this.clients.find((c) => c.config.name === serverName);
        const handler = client
            ? async (args) => {
                try {
                    return await client.callTool(toolInfo.name, args);
                }
                catch (e) {
                    return `Error calling MCP tool '${toolInfo.name}': ${e.message}`;
                }
            }
            : async () => 'MCP tool unavailable: server disconnected';
        const tool = new Tool({
            name: `mcp_${serverName}_${toolInfo.name}`,
            description: `[MCP:${serverName}] ${toolInfo.description ?? toolInfo.name}`,
            parameters,
            handler,
            cacheable: false,
        });
        this.toolRegistry.register(tool);
    }
}
