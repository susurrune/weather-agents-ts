/** Voice WebSocket server — mirrors Python web/server.py.
 *
 * Bridges a browser voice client (client.html, served as voice.html) to an
 * agent's chatStream over a WebSocket. Each connection gets its own memory
 * session; optional Doubao TTS streams synthesized audio back as base64 frames.
 */
import type { SystemContext } from '../core/factory.js';
export interface VoiceServerOptions {
    host?: string;
    port?: number;
    agentName?: string;
    certFile?: string | null;
    keyFile?: string | null;
}
export declare function runVoiceServer(ctx: SystemContext, opts?: VoiceServerOptions): Promise<void>;
