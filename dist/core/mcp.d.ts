/** MCP (Model Context Protocol) client — Anthropic-compatible transport.
 *
 * Implements the MCP 2025-03-26 specification with two transports:
 * - stdio: subprocess-based JSON-RPC over stdin/stdout
 * - SSE: text/event-stream via fetch with jsonrpc POST endpoint
 */
import { ToolRegistry } from './tool.js';
export interface MCPServerConfig {
    name: string;
    command?: string | null;
    args?: string[];
    url?: string | null;
    env?: Record<string, string>;
    enabled?: boolean;
}
export declare class MCPClient {
    readonly config: MCPServerConfig;
    private process;
    private serverTools;
    private nextId;
    private pending;
    private readerTask;
    private responseLineBuffer;
    private responseResolver;
    private sseAbortController;
    private sseMessageEndpoint;
    constructor(config: MCPServerConfig);
    private newId;
    initialize(): Promise<any[]>;
    healthCheck(): Promise<{
        healthy: boolean;
        details: string;
    }>;
    close(): Promise<void>;
    private initStdio;
    private setupStdioReader;
    private drainStderr;
    private sendJson;
    private requestStdio;
    private healthStdio;
    /**
     * Call a tool on this server via tools/call (transport-agnostic). Returns the
     * extracted text content, or a JSON-stringified fallback. Public so the
     * manager doesn't reach into private transport methods.
     */
    callTool(name: string, args: Record<string, unknown>, timeout?: number): Promise<string>;
    private initSse;
    private requestSse;
    private healthSse;
}
export declare class MCPManager {
    private readonly clients;
    private readonly toolRegistry;
    constructor(toolRegistry: ToolRegistry);
    configure(servers: MCPServerConfig[]): void;
    connectAll(): Promise<string[]>;
    closeAll(): Promise<void>;
    private registerMcpTool;
}
