/** Voice WebSocket server — minimal but functional. Mirrors Python web/server.py. */
import type { SystemContext } from '../core/factory.js';
/**
 * Run a minimal voice WebSocket server. Clients send `{"type":"speech","text":"…"}`
 * JSON frames; the server streams the agent's response back via `{"type":"content","text":"…"}`
 * frames.
 */
export declare function runVoiceServer(ctx: SystemContext, opts?: {
    host?: string;
    port?: number;
    agentName?: string;
}): Promise<void>;
