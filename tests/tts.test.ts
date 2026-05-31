import { describe, it, expect, afterEach } from 'vitest';
import { DoubaoTTS, VOICE_CATALOG, getVoiceByKey, getVoiceType } from '../src/web/tts.js';

// Build a Response whose body streams the given lines (newline-delimited).
function streamResponse(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('voice catalog helpers', () => {
  it('getVoiceByKey hits and misses', () => {
    expect(getVoiceByKey('cancan')?.voice_type).toBe('zh_female_cancan_uranus_bigtts');
    expect(getVoiceByKey('nope')).toBeNull();
  });

  it('getVoiceType resolves keys and passes through raw ids', () => {
    expect(getVoiceType('uranus')).toBe('zh_female_vv_uranus_bigtts');
    expect(getVoiceType('zh_female_custom_bigtts')).toBe('zh_female_custom_bigtts');
  });

  it('catalog entries are well-formed', () => {
    for (const v of VOICE_CATALOG) {
      expect(v.key).toBeTruthy();
      expect(v.voice_type).toMatch(/_bigtts$/);
    }
  });
});

describe('DoubaoTTS.isAvailable', () => {
  it('true with apiKey', () => {
    expect(new DoubaoTTS({ apiKey: 'k' }).isAvailable).toBe(true);
  });
  it('true with appId + accessToken', () => {
    expect(new DoubaoTTS({ appId: 'a', accessToken: 't' }).isAvailable).toBe(true);
  });
  it('false with neither (or partial legacy creds)', () => {
    expect(new DoubaoTTS({}).isAvailable).toBe(false);
    expect(new DoubaoTTS({ appId: 'a' }).isAvailable).toBe(false);
  });
});

describe('DoubaoTTS.synthesizeStream', () => {
  it('yields base64 chunks and stops on the terminal code', async () => {
    let captured: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      captured = init;
      return streamResponse([
        JSON.stringify({ code: 0, data: 'AAAA' }) + '\n',
        JSON.stringify({ code: 0, data: { audio: 'BBBB' } }) + '\n',
        JSON.stringify({ code: 20000000 }) + '\n',
        JSON.stringify({ code: 0, data: 'CCCC' }) + '\n', // after end — ignored
      ]);
    }) as typeof fetch;

    const tts = new DoubaoTTS({ apiKey: 'k', voiceType: 'v1' });
    const out: string[] = [];
    for await (const b64 of tts.synthesizeStream('你好')) out.push(b64);

    expect(out).toEqual(['AAAA', 'BBBB']);
    // apiKey auth header chosen
    expect(captured.headers['X-Api-Key']).toBe('k');
    const body = JSON.parse(captured.body);
    expect(body.req_params.speaker).toBe('v1');
  });

  it('throws on an API error code', async () => {
    globalThis.fetch = (async () =>
      streamResponse([JSON.stringify({ code: 3001, message: 'bad' }) + '\n'])) as typeof fetch;
    const tts = new DoubaoTTS({ apiKey: 'k' });
    await expect(async () => {
      for await (const _ of tts.synthesizeStream('x')) void _;
    }).rejects.toThrow(/TTS API error \(3001\)/);
  });

  it('throws on a non-200 response', async () => {
    globalThis.fetch = (async () => streamResponse(['nope'], 500)) as typeof fetch;
    const tts = new DoubaoTTS({ apiKey: 'k' });
    await expect(async () => {
      for await (const _ of tts.synthesizeStream('x')) void _;
    }).rejects.toThrow(/TTS HTTP 500/);
  });

  it('empty text yields nothing without calling fetch', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return streamResponse([]);
    }) as typeof fetch;
    const tts = new DoubaoTTS({ apiKey: 'k' });
    const out: string[] = [];
    for await (const b64 of tts.synthesizeStream('   ')) out.push(b64);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('requires credentials before streaming', async () => {
    const tts = new DoubaoTTS({});
    await expect(async () => {
      for await (const _ of tts.synthesizeStream('x')) void _;
    }).rejects.toThrow(/requires apiKey/);
  });
});
