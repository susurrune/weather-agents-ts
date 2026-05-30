/** Voice WebSocket server — minimal but functional. Mirrors Python web/server.py. */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { detectAllLanIps } from './certs.js';
import { getLogger } from '../core/logger.js';
const log = getLogger('voice');
const _here = (() => {
    try {
        return fileURLToPath(import.meta.url);
    }
    catch {
        return process.cwd();
    }
})();
const HTML_PATH = join(_here, '..', '..', 'web', 'voice.html');
/**
 * Run a minimal voice WebSocket server. Clients send `{"type":"speech","text":"…"}`
 * JSON frames; the server streams the agent's response back via `{"type":"content","text":"…"}`
 * frames.
 */
export async function runVoiceServer(ctx, opts = {}) {
    const { host = '127.0.0.1', port = 8765, agentName = 'fair' } = opts;
    const agent = ctx.agentMap[agentName];
    if (!agent)
        throw new Error(`Unknown agent: ${agentName}`);
    await agent.init();
    const allIps = detectAllLanIps();
    const htmlContent = existsSync(HTML_PATH)
        ? readFileSync(HTML_PATH, 'utf-8')
        : '<h1>Voice client not found</h1>';
    const htmlEtag = createHash('md5').update(htmlContent).digest('hex').slice(0, 16);
    const server = createServer(async (req, res) => {
        // Health check
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', agent: agent.name }));
            return;
        }
        // WebSocket upgrade
        if (req.url === '/ws' && req.headers.upgrade?.toLowerCase() === 'websocket') {
            await agent.init();
            await agent.memory.createSession();
            const sessionId = agent.memory.getActiveSession();
            // Perform handshake
            const key = req.headers['sec-websocket-key'];
            const accept = createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                .digest('base64');
            const socket = req.socket;
            res.writeHead(101, {
                Upgrade: 'websocket',
                Connection: 'Upgrade',
                'Sec-WebSocket-Accept': accept,
            });
            res.end();
            log.info('voice_ws_open', { session: sessionId });
            let buffer = Buffer.alloc(0);
            socket.on('data', async (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                // Simple WebSocket frame parser (text frames only, no masking for server→client)
                while (buffer.length >= 2) {
                    const opcode = buffer[0] & 0x0f;
                    if (opcode === 0x8) {
                        socket.destroy();
                        return;
                    } // close
                    if (opcode !== 0x1)
                        break; // only text frames
                    const masked = (buffer[1] & 0x80) !== 0;
                    let payloadLen = buffer[1] & 0x7f;
                    let offset = 2;
                    if (payloadLen === 126) {
                        if (buffer.length < 4)
                            break;
                        payloadLen = buffer.readUInt16BE(2);
                        offset = 4;
                    }
                    else if (payloadLen === 127) {
                        if (buffer.length < 10)
                            break;
                        payloadLen = Number(buffer.readBigUInt64BE(2));
                        offset = 10;
                    }
                    if (buffer.length < offset + (masked ? 4 : 0) + payloadLen)
                        break;
                    const mask = masked ? buffer.slice(offset, offset + 4) : null;
                    offset += masked ? 4 : 0;
                    let payload = buffer.slice(offset, offset + payloadLen);
                    if (mask) {
                        for (let i = 0; i < payload.length; i++) {
                            const m = mask[i % 4];
                            const p = payload[i];
                            if (m !== undefined && p !== undefined)
                                payload[i] = p ^ m;
                        }
                    }
                    buffer = buffer.slice(offset + payloadLen);
                    try {
                        const msg = JSON.parse(payload.toString('utf-8'));
                        if (msg.type === 'speech' && msg.text) {
                            await agent.memory.loadSession(sessionId);
                            const text = msg.text;
                            for await (const ev of agent.chatStream(text)) {
                                if (ev.type === 'content') {
                                    sendWsFrame(socket, JSON.stringify({ type: 'content', text: ev.text }));
                                }
                                else if (ev.type === 'done') {
                                    sendWsFrame(socket, JSON.stringify({ type: 'done' }));
                                }
                                else if (ev.type === 'tool_status') {
                                    sendWsFrame(socket, JSON.stringify({ type: 'tool_status', label: ev.label }));
                                }
                            }
                        }
                        else if (msg.type === 'ping') {
                            sendWsFrame(socket, JSON.stringify({ type: 'pong' }));
                        }
                        else if (msg.type === 'list_agents') {
                            const list = Object.entries(ctx.agentMap).map(([n, a]) => ({
                                name: n,
                                display_name: a.displayName,
                                emoji: a.emoji,
                                specialty: a.specialty,
                            }));
                            sendWsFrame(socket, JSON.stringify({ type: 'agent_list', agents: list, current: agentName }));
                        }
                        else if (msg.type === 'switch_agent') {
                            const target = msg.agent;
                            if (ctx.agentMap[target]) {
                                await ctx.agentMap[target].init();
                                sendWsFrame(socket, JSON.stringify({ type: 'agent_switched', agent: target }));
                            }
                        }
                    }
                    catch {
                        /* invalid JSON — ignore */
                    }
                }
            });
            socket.on('close', () => {
                log.info('voice_ws_close', { session: sessionId });
            });
            socket.on('error', () => {
                socket.destroy();
            });
            return;
        }
        // Serve HTML client
        if (req.headers['if-none-match'] === htmlEtag) {
            res.writeHead(304).end();
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            ETag: htmlEtag,
        });
        res.end(htmlContent);
    });
    server.listen(port, host, () => {
        console.log(`\n  🎤 Voice server — ${agent.displayName}`);
        console.log(`  http://127.0.0.1:${port}  (本机)`);
        for (const ip of allIps) {
            console.log(`  http://${ip}:${port}  (LAN)`);
        }
        console.log('');
    });
    // Graceful shutdown
    process.on('SIGINT', () => {
        server.close();
        process.exit();
    });
    process.on('SIGTERM', () => {
        server.close();
        process.exit();
    });
}
/** Send a WebSocket text frame. */
function sendWsFrame(socket, text) {
    const payload = Buffer.from(text, 'utf-8');
    let frame;
    if (payload.length < 126) {
        frame = Buffer.alloc(2 + payload.length);
        frame[0] = 0x81; // FIN + text opcode
        frame[1] = payload.length;
        payload.copy(frame, 2);
    }
    else if (payload.length < 65536) {
        frame = Buffer.alloc(4 + payload.length);
        frame[0] = 0x81;
        frame[1] = 126;
        frame.writeUInt16BE(payload.length, 2);
        payload.copy(frame, 4);
    }
    else {
        frame = Buffer.alloc(10 + payload.length);
        frame[0] = 0x81;
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(payload.length), 2);
        payload.copy(frame, 10);
    }
    try {
        socket.write(frame);
    }
    catch {
        /* socket closed */
    }
}
