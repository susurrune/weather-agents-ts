/** Voice WebSocket server — mirrors Python web/server.py.
 *
 * Bridges a browser voice client (client.html, served as voice.html) to an
 * agent's chatStream over a WebSocket. Each connection gets its own memory
 * session; optional Doubao TTS streams synthesized audio back as base64 frames.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { detectAllLanIps } from './certs.js';
import { DoubaoTTS } from './tts.js';
import { getLogger } from '../core/logger.js';
import type { SystemContext } from '../core/factory.js';
import type { BaseAgent } from '../core/agent.js';

const log = getLogger('voice');

const _here = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.cwd();
  }
})();
const HTML_PATH = join(_here, '..', 'voice.html');

const IDLE_TIMEOUT_MS = 300_000; // close WS after 5 min of silence

export interface VoiceServerOptions {
  host?: string;
  port?: number;
  agentName?: string;
  certFile?: string | null;
  keyFile?: string | null;
}

/** Strip common markdown so TTS reads clean prose (mirrors _strip_markdown). */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function runVoiceServer(
  ctx: SystemContext,
  opts: VoiceServerOptions = {},
): Promise<void> {
  const {
    host = '0.0.0.0',
    port = 8765,
    agentName = 'fair',
    certFile = null,
    keyFile = null,
  } = opts;

  if (!ctx.agentMap[agentName]) throw new Error(`unknown agent: ${agentName}`);

  // Server-level "current agent" — runtime switchable via WS, like Python.
  let currentAgentName = agentName;
  const agentOf = (name: string): BaseAgent | undefined => ctx.agentMap[name];

  await ctx.agentMap[agentName]!.init();

  // Optional TTS engine (only when configured + enabled).
  const ttsCfg = ctx.config.tts;
  let tts: DoubaoTTS | null = null;
  if (ttsCfg.enabled) {
    const engine = new DoubaoTTS({
      accessToken: ttsCfg.accessToken || null,
      apiKey: ttsCfg.apiKey || null,
      appId: ttsCfg.appId || null,
      resourceId: ttsCfg.resourceId,
      voiceType: ttsCfg.voiceType,
      encoding: ttsCfg.encoding,
      speedRatio: ttsCfg.speedRatio,
      volumeRatio: ttsCfg.volumeRatio,
      pitchRatio: ttsCfg.pitchRatio,
      emotion: ttsCfg.emotion,
    });
    if (engine.isAvailable) tts = engine;
    else log.warning('tts_enabled_but_no_credentials', {});
  }

  const allIps = detectAllLanIps();

  const htmlContent = existsSync(HTML_PATH)
    ? readFileSync(HTML_PATH, 'utf-8')
    : '<h1>Voice client not found</h1>';
  const htmlEtag = createHash('md5').update(htmlContent).digest('hex').slice(0, 16);

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agent: currentAgentName }));
      return;
    }
    if (req.url === '/ws' && req.headers.upgrade?.toLowerCase() === 'websocket') {
      handleWsUpgrade(req, res);
      return;
    }
    if (req.headers['if-none-match'] === htmlEtag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: htmlEtag });
    res.end(htmlContent);
  };

  const useSsl = Boolean(certFile && keyFile);
  const server = useSsl
    ? createHttpsServer(
        { cert: readFileSync(certFile!), key: readFileSync(keyFile!) },
        requestHandler,
      )
    : createHttpServer(requestHandler);

  function handleWsUpgrade(req: IncomingMessage, res: ServerResponse): void {
    const socket: Socket = (req as any).socket;
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      res.writeHead(400).end();
      return;
    }
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    res.writeHead(101, {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Accept': accept,
    });
    res.end();
    void runWsSession(socket).catch((e) => log.warning('voice_ws_error', { error: String(e) }));
  }

  // One WS connection ↔ one isolated memory session, cleaned up on close.
  async function runWsSession(socket: Socket): Promise<void> {
    let myAgentName = currentAgentName;
    const agent = agentOf(myAgentName)!;
    await agent.init();
    await agent.memory.createSession();
    let sessionId = agent.memory.getActiveSession();
    const openSessions: Array<[string, string]> = sessionId ? [[myAgentName, sessionId]] : [];

    log.info('voice_ws_open', { session: sessionId });

    let idleTimer: NodeJS.Timeout | null = null;
    let busy = false; // serialize speech turns within a connection
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send(socket, { type: 'error', text: 'idle timeout' });
        socket.destroy();
      }, IDLE_TIMEOUT_MS);
    };
    resetIdle();

    const cleanup = async (): Promise<void> => {
      if (idleTimer) clearTimeout(idleTimer);
      log.info('voice_ws_close', { sessions: openSessions.map(([, s]) => s) });
      for (const [an, sid] of openSessions) {
        const a = agentOf(an);
        if (a) {
          try {
            await a.memory.deleteSession(sid);
          } catch {
            /* best effort */
          }
        }
      }
    };

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frame: { opcode: number; payload: Buffer } | null;
      while ((frame = readFrame())) {
        if (frame.opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (frame.opcode !== 0x1) continue; // text frames only
        resetIdle();
        void onText(frame.payload.toString('utf-8'));
      }
    });
    socket.on('close', () => void cleanup());
    socket.on('error', () => socket.destroy());

    // Returns the next complete frame from `buffer`, or null if incomplete.
    function readFrame(): { opcode: number; payload: Buffer } | null {
      if (buffer.length < 2) return null;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let len = buffer[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return null;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return null;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + (masked ? 4 : 0) + len) return null;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      }
      buffer = buffer.subarray(offset + len);
      return { opcode, payload };
    }

    async function activateSession(): Promise<void> {
      const a = agentOf(myAgentName);
      if (!a || !sessionId) return;
      if (a.memory.getActiveSession() === sessionId) return;
      const ok = await a.memory.loadSession(sessionId);
      if (!ok) await a.memory.createSession();
    }

    async function onText(raw: string): Promise<void> {
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        send(socket, { type: 'error', text: 'invalid json' });
        return;
      }
      const type = data?.type ?? '';
      if (type === 'speech') {
        const text = String(data.text ?? '').trim();
        if (!text || !sessionId || busy) return;
        busy = true;
        try {
          await activateSession();
          await handleSpeech(text);
        } finally {
          busy = false;
        }
      } else if (type === 'ping') {
        send(socket, { type: 'pong' });
      } else if (type === 'list_agents') {
        send(socket, {
          type: 'agent_list',
          agents: buildAgentList(),
          current: myAgentName,
        });
      } else if (type === 'switch_agent') {
        await handleSwitch(String(data.agent ?? ''));
      }
    }

    function buildAgentList(): Array<Record<string, string>> {
      return Object.values(ctx.agentMap).map((a) => ({
        name: a.name,
        display_name: a.displayName,
        emoji: a.emoji,
        specialty: a.specialty,
      }));
    }

    async function handleSwitch(name: string): Promise<void> {
      if (!ctx.agentMap[name]) {
        send(socket, { type: 'error', text: `unknown agent: ${name}` });
        return;
      }
      if (name === myAgentName) return;
      // Init the new agent FIRST — keep current intact if it fails.
      try {
        await ctx.agentMap[name]!.init();
        await ctx.agentMap[name]!.memory.createSession();
      } catch (e) {
        log.warning('voice_ws_switch_agent_failed', { agent: name, error: String(e) });
        send(socket, { type: 'error', text: `failed to switch to ${name}` });
        return;
      }
      // Teardown old session, then switch.
      const old = agentOf(myAgentName);
      if (old && sessionId) {
        try {
          await old.memory.deleteSession(sessionId);
        } catch {
          /* best effort */
        }
        const idx = openSessions.findIndex(([, s]) => s === sessionId);
        if (idx >= 0) openSessions.splice(idx, 1);
      }
      currentAgentName = name;
      myAgentName = name;
      const newSid = ctx.agentMap[name]!.memory.getActiveSession();
      if (newSid) {
        sessionId = newSid;
        openSessions.push([myAgentName, newSid]);
      }
      send(socket, {
        type: 'agent_switched',
        agent: name,
        display_name: ctx.agentMap[name]!.displayName,
        emoji: ctx.agentMap[name]!.emoji,
        specialty: ctx.agentMap[name]!.specialty,
        session_id: newSid,
      });
    }

    async function handleSpeech(text: string): Promise<void> {
      send(socket, { type: 'start' });
      let full = '';
      try {
        for await (const ev of agentOf(myAgentName)!.chatStream(text)) {
          if (ev.type === 'content') {
            const t = ev.text ?? '';
            full += t;
            send(socket, { type: 'content', text: t });
          } else if (ev.type === 'tool_status') {
            send(socket, { type: 'status', label: ev.label ?? '' });
          } else if (ev.type === 'done') {
            break;
          }
        }
      } catch (e) {
        log.warning('voice_speech_error', { error: String(e) });
        send(socket, { type: 'error', text: `error: ${String(e)}` });
        return;
      }

      const clean = stripMarkdown(full);
      send(socket, {
        type: 'done',
        full_text: clean,
        raw_text: full,
        ...(tts && clean ? { tts: 'doubao' } : {}),
      });

      if (tts && clean) await synthesizeAudio(clean);
    }

    async function synthesizeAudio(text: string): Promise<void> {
      if (!tts) return;
      try {
        send(socket, { type: 'audio_start', format: tts.encoding });
        let sent = 0;
        for await (const b64 of tts.synthesizeStream(text)) {
          sent += 1;
          send(socket, { type: 'audio_chunk', data: b64 });
        }
        if (sent) send(socket, { type: 'audio_end' });
        else {
          log.warning('tts_empty_audio', {});
          send(socket, { type: 'audio_end', error: 'empty' });
        }
      } catch (e) {
        log.warning('tts_synthesis_error', { error: String(e) });
        send(socket, { type: 'audio_end', error: String(e) });
      }
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const scheme = useSsl ? 'https' : 'http';
      console.log(`\n  🎤 Voice server — ${ctx.agentMap[agentName]!.displayName}`);
      console.log(`  ${scheme}://127.0.0.1:${port}  (本机)`);
      for (const ip of allIps) console.log(`  ${scheme}://${ip}:${port}  (LAN)`);
      console.log('');
      resolve();
    });
  });

  const shutdown = (): void => {
    server.close();
    if (tts) void tts.close();
    process.exit();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive until the server closes.
  await new Promise<void>((resolve) => server.on('close', resolve));
}

/** Send a JSON object as a single WebSocket text frame (server→client, unmasked). */
function send(socket: Socket, obj: Record<string, unknown>): void {
  const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  let frame: Buffer;
  if (payload.length < 126) {
    frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x81;
    frame[1] = payload.length;
    payload.copy(frame, 2);
  } else if (payload.length < 65536) {
    frame = Buffer.alloc(4 + payload.length);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.alloc(10 + payload.length);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
    payload.copy(frame, 10);
  }
  try {
    socket.write(frame);
  } catch {
    /* socket closed */
  }
}
