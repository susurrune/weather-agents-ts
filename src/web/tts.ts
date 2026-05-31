/**
 * Doubao (Volcano Engine) TTS — V3 HTTP Unidirectional API.
 *
 * POSTs text to the TTS endpoint and yields base64 audio chunks as they
 * stream back, so the voice server can forward them to the browser without a
 * decode/re-encode round-trip.
 */

const HTTP_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

// ── Voice catalog ──────────────────────────────────────────────────────────

export interface VoiceEntry {
  key: string;
  name: string;
  desc: string;
  voice_type: string;
}

export const VOICE_CATALOG: VoiceEntry[] = [
  {
    key: 'xiaohe',
    name: '小河',
    desc: '温柔自然女声',
    voice_type: 'zh_female_xiaohe_uranus_bigtts',
  },
  {
    key: 'qingxinnvsheng',
    name: '清新女声',
    desc: '清澈自然女声',
    voice_type: 'zh_female_qingxinnvsheng_uranus_bigtts',
  },
  {
    key: 'cancan',
    name: '灿灿',
    desc: '活力甜美少女音',
    voice_type: 'zh_female_cancan_uranus_bigtts',
  },
  {
    key: 'sajiaoxuemei',
    name: '撒娇雪梅',
    desc: '甜美撒娇少女音',
    voice_type: 'zh_female_sajiaoxuemei_uranus_bigtts',
  },
  {
    key: 'meilinvyou',
    name: '魅力女游',
    desc: '温柔魅力女声',
    voice_type: 'zh_female_meilinvyou_uranus_bigtts',
  },
  {
    key: 'uranus',
    name: '乌拉努斯',
    desc: '大气知性女声',
    voice_type: 'zh_female_vv_uranus_bigtts',
  },
  {
    key: 'tianmeitaozi',
    name: '甜美桃子',
    desc: '甜美软萌少女音',
    voice_type: 'zh_female_tianmeitaozi_uranus_bigtts',
  },
];

export function getVoiceByKey(key: string): VoiceEntry | null {
  return VOICE_CATALOG.find((v) => v.key === key) ?? null;
}

/** Resolve a catalog key OR a raw voice_type to a voice_type id (passthrough). */
export function getVoiceType(keyOrType: string): string {
  return getVoiceByKey(keyOrType)?.voice_type ?? keyOrType;
}

// ── DoubaoTTS client ─────────────────────────────────────────────────────

export interface DoubaoTTSOptions {
  accessToken?: string | null;
  apiKey?: string | null;
  appId?: string | null;
  resourceId?: string;
  voiceType?: string;
  encoding?: string;
  speedRatio?: number;
  volumeRatio?: number;
  pitchRatio?: number;
  emotion?: string;
}

export class DoubaoTTS {
  readonly accessToken: string | null;
  readonly apiKey: string | null;
  readonly appId: string | null;
  readonly resourceId: string;
  readonly voiceType: string;
  readonly encoding: string;
  readonly speedRatio: number;
  readonly volumeRatio: number;
  readonly pitchRatio: number;
  readonly emotion: string;

  constructor(opts: DoubaoTTSOptions = {}) {
    this.accessToken = opts.accessToken ?? null;
    this.apiKey = opts.apiKey ?? null;
    this.appId = opts.appId ?? null;
    this.resourceId = opts.resourceId ?? 'seed-tts-2.0';
    this.voiceType = opts.voiceType ?? 'zh_female_sajiaoxuemei_uranus_bigtts';
    this.encoding = opts.encoding ?? 'mp3';
    this.speedRatio = opts.speedRatio ?? 1.0;
    this.volumeRatio = opts.volumeRatio ?? 1.0;
    this.pitchRatio = opts.pitchRatio ?? 1.0;
    this.emotion = opts.emotion ?? 'happy';
  }

  get isAvailable(): boolean {
    return Boolean(this.apiKey) || (Boolean(this.appId) && Boolean(this.accessToken));
  }

  /** No persistent connection to tear down (fetch is stateless); kept for parity. */
  async close(): Promise<void> {
    /* noop — fetch holds no pooled client we own */
  }

  /**
   * Stream TTS audio as base64 chunks. The V3 unidirectional API returns
   * newline-delimited JSON; we parse incrementally and yield each `data`
   * field. Throws on an API error code; ends cleanly on code 20000000.
   */
  async *synthesizeStream(text: string): AsyncGenerator<string, void, void> {
    const t = text.trim();
    if (!t) return;

    const resp = await fetch(HTTP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.httpHeaders() },
      body: JSON.stringify(this.requestBody(t)),
    });

    if (resp.status !== 200 || !resp.body) {
      const preview = await resp.text().catch(() => '');
      throw new Error(`TTS HTTP ${resp.status}: ${preview.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Last element is the (possibly incomplete) trailing line.
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const stripped = line.trim();
          if (!stripped) continue;
          const { audio, end } = this.parseLine(stripped);
          if (end) return;
          if (audio) yield audio;
        }
      }
      const tail = buffer.trim();
      if (tail) {
        const { audio, end } = this.parseLine(tail);
        if (end) return;
        if (audio) yield audio;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  /** Accumulate the full audio into a single Buffer (non-streaming callers). */
  async synthesize(text: string): Promise<Buffer> {
    const t = text.trim();
    if (!t) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    for await (const b64 of this.synthesizeStream(t)) {
      parts.push(Buffer.from(b64, 'base64'));
    }
    if (!parts.length) throw new Error('TTS response missing data field');
    return Buffer.concat(parts);
  }

  // ── helpers ──

  // Returns { audio?, end } — `end:true` on the terminal code, throws on error.
  private parseLine(line: string): { audio?: string; end: boolean } {
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      return { end: false }; // skip non-JSON noise
    }
    const code = payload?.code ?? 0;
    if (code === 20000000) return { end: true };
    if (code !== 0) {
      const msg = payload?.message ?? 'unknown error';
      throw new Error(`TTS API error (${code}): ${msg}`);
    }
    const data = payload?.data;
    if (typeof data === 'string') return { audio: data, end: false };
    if (data && typeof data === 'object' && typeof data.audio === 'string') {
      return { audio: data.audio, end: false };
    }
    return { end: false };
  }

  private httpHeaders(): Record<string, string> {
    if (this.apiKey) {
      return { 'X-Api-Key': this.apiKey, 'X-Api-Resource-Id': this.resourceId };
    }
    if (this.appId && this.accessToken) {
      return {
        'X-Api-App-Id': this.appId,
        'X-Api-Access-Key': this.accessToken,
        'X-Api-Resource-Id': this.resourceId,
      };
    }
    throw new Error('DoubaoTTS requires apiKey (new console) or appId+accessToken (legacy)');
  }

  private requestBody(text: string): Record<string, unknown> {
    const audioParams: Record<string, unknown> = {
      format: this.encoding,
      sample_rate: 24000,
    };
    const speed = mapRate(this.speedRatio, 0.5, 2.0, -50, 100);
    const loudness = mapRate(this.volumeRatio, 0.5, 2.0, -50, 100);
    if (speed !== 0) audioParams.speech_rate = speed;
    if (loudness !== 0) audioParams.loudness_rate = loudness;

    return {
      user: { uid: 'wa_voice' },
      req_params: {
        text,
        speaker: this.voiceType,
        audio_params: audioParams,
      },
    };
  }
}

/** Map a float ratio onto the API's integer range (clamped). */
function mapRate(
  value: number,
  srcMin: number,
  srcMax: number,
  dstMin: number,
  dstMax: number,
): number {
  if (value <= 0) return dstMin;
  const srcRange = srcMax - srcMin || 1;
  let norm = (value - srcMin) / srcRange;
  norm = Math.max(0, Math.min(1, norm));
  return dstMin + Math.round(norm * (dstMax - dstMin));
}
