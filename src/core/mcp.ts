/** MCP (Model Context Protocol) client — Anthropic-compatible transport.
 *
 * Implements the MCP 2025-03-26 specification with two transports:
 * - stdio: subprocess-based JSON-RPC over stdin/stdout
 * - SSE: text/event-stream via fetch with jsonrpc POST endpoint
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getLogger } from './logger.js';
import { Tool, ToolRegistry, type ToolParameter } from './tool.js';

const log = getLogger('mcp');

const MCP_PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'weather-agents', version: '1.0.0' };

// ── Config ───────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  name: string;
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  enabled?: boolean;
}

// ── MCPClient (single server) ────────────────────────────────────────────

export class MCPClient {
  readonly config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private serverTools: any[] = [];
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readerTask: Promise<void> | null = null;
  private responseLineBuffer = '';
  private responseResolver: ((line: string) => void) | null = null;
  // SSE state
  private sseAbortController: AbortController | null = null;
  private sseMessageEndpoint: string | null = null;

  constructor(config: MCPServerConfig) {
    this.config = { args: [], env: {}, enabled: true, ...config };
  }

  private newId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  // ── Public API ───────────────────────────────────────────────────────

  async initialize(): Promise<any[]> {
    try {
      if (this.config.command) return await this.initStdio();
      if (this.config.url) return await this.initSse();
    } catch (e: any) {
      log.warning('mcp_server_unavailable', { server: this.config.name, error: String(e) });
    }
    return [];
  }

  async healthCheck(): Promise<{ healthy: boolean; details: string }> {
    if (this.config.command) return this.healthStdio();
    if (this.config.url) return this.healthSse();
    return { healthy: false, details: 'No transport configured' };
  }

  async close(): Promise<void> {
    // Cancel SSE first
    try {
      this.sseAbortController?.abort();
    } catch {
      /* noop */
    }
    // Reject all pending
    for (const [, p] of this.pending) p.reject(new Error('Connection closed'));
    this.pending.clear();
    // Kill subprocess
    if (this.process && !this.process.killed) {
      try {
        this.process.kill();
      } catch {
        /* noop */
      }
    }
    this.process = null;
    this.readerTask = null;
    this.serverTools = [];
  }

  // ── stdio transport ──────────────────────────────────────────────────

  private async initStdio(): Promise<any[]> {
    const cmd = this.config.command;
    if (!cmd) return [];

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
      if (!initResp || initResp.error) return [];

      await this.sendJson({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

      const toolsResp = await this.requestStdio('tools/list', {});
      if (toolsResp?.result) {
        this.serverTools = toolsResp.result.tools || [];
      }
      return this.serverTools;
    } catch (e: any) {
      log.warning('mcp_stdio_init_failed', { server: this.config.name, error: String(e) });
      await this.close();
      return [];
    }
  }

  private setupStdioReader(): void {
    if (!this.process?.stdout) return;
    const rl = createInterface({ input: this.process.stdout, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line.trim());
        if (msg?.id !== undefined && msg?.id !== null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg);
          }
        }
      } catch {
        // Skip non-JSON lines (stderr noise, protocol logs)
      }
    });

    rl.on('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('stdio stream closed'));
      this.pending.clear();
    });

    this.readerTask = new Promise(() => {}); // keep-alive marker
  }

  private drainStderr(): void {
    if (!this.process?.stderr) return;
    const rl = createInterface({ input: this.process.stderr, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      log.debug('mcp_stderr', { server: this.config.name, line: line.slice(0, 200) });
    });
  }

  private sendJson(msg: Record<string, any>): void {
    if (!this.process?.stdin || this.process.killed) return;
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private requestStdio(method: string, params: Record<string, any>, timeout = 10.0): Promise<any> {
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

  private healthStdio(): { healthy: boolean; details: string } {
    if (!this.process || this.process.exitCode !== null || this.process.killed) {
      return { healthy: false, details: 'stdio process not running' };
    }
    this.requestStdio('ping', {}, 5.0)
      .then((r) => (r?.result ? null : null))
      .catch(() => null);
    return { healthy: true, details: 'ok' };
  }

  // ── SSE transport ────────────────────────────────────────────────────

  private async initSse(): Promise<any[]> {
    try {
      const url = this.config.url;
      if (!url) return [];

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
            if (d?.endpoint) this.sseMessageEndpoint = d.endpoint;
          } catch {
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
      if (!initResp || initResp.error) return [];

      await this.requestSse('notifications/initialized', {});

      const toolsResp = await this.requestSse('tools/list', {});
      if (toolsResp?.result) {
        this.serverTools = toolsResp.result.tools || [];
      }
      return this.serverTools;
    } catch (e: any) {
      log.warning('mcp_sse_init_failed', { server: this.config.name, error: String(e) });
      return [];
    }
  }

  private async requestSse(
    method: string,
    params: Record<string, any>,
    timeout = 10.0,
  ): Promise<any> {
    if (!this.sseMessageEndpoint) return null;
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
      const d: any = await res.json().catch(() => null);
      return d;
    } catch {
      return { error: 'SSE request failed or timed out' };
    } finally {
      clearTimeout(timer);
    }
  }

  private healthSse(): { healthy: boolean; details: string } {
    if (!this.sseMessageEndpoint) return { healthy: false, details: 'No SSE message endpoint' };
    return { healthy: true, details: 'ok' };
  }
}

// ── MCPManager (multi-server registry) ────────────────────────────────

export class MCPManager {
  private readonly clients: MCPClient[] = [];
  private readonly toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  configure(servers: MCPServerConfig[]): void {
    for (const sc of servers) {
      if (sc.enabled !== false && (sc.command || sc.url)) {
        this.clients.push(new MCPClient(sc));
      }
    }
  }

  async connectAll(): Promise<string[]> {
    const status: string[] = [];
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
      } catch (e: any) {
        log.warning('mcp_connect_failed', { server: client.config.name, error: String(e) });
        status.push(`${client.config.name} (failed)`);
      }
    }
    return status;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
    this.clients.length = 0;
  }

  private registerMcpTool(serverName: string, toolInfo: any): void {
    // Map MCP JSON Schema (inputSchema) to our ToolParameter format
    const inputSchema = toolInfo.inputSchema ?? {};
    const properties: Record<string, any> = inputSchema.properties ?? {};
    const required: string[] = inputSchema.required ?? [];

    const parameters: ToolParameter[] = [];
    for (const [name, prop] of Object.entries(properties)) {
      const p = prop as any;
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
      ? async (args: Record<string, any>): Promise<string> => {
          try {
            const resp = client.config.url
              ? await (client as any).requestSse(
                  'tools/call',
                  {
                    name: toolInfo.name,
                    arguments: args,
                  },
                  30.0,
                )
              : await (client as any).requestStdio(
                  'tools/call',
                  {
                    name: toolInfo.name,
                    arguments: args,
                  },
                  30.0,
                );
            if (resp?.result?.content?.[0]?.text) {
              return resp.result.content[0].text;
            }
            return JSON.stringify(resp?.result ?? resp?.error ?? 'no response');
          } catch (e: any) {
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
