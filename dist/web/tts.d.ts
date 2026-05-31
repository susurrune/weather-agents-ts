/**
 * Doubao (Volcano Engine) TTS — V3 HTTP Unidirectional API.
 *
 * POSTs text to the TTS endpoint and yields base64 audio chunks as they
 * stream back, so the voice server can forward them to the browser without a
 * decode/re-encode round-trip.
 */
export interface VoiceEntry {
    key: string;
    name: string;
    desc: string;
    voice_type: string;
}
export declare const VOICE_CATALOG: VoiceEntry[];
export declare function getVoiceByKey(key: string): VoiceEntry | null;
/** Resolve a catalog key OR a raw voice_type to a voice_type id (passthrough). */
export declare function getVoiceType(keyOrType: string): string;
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
export declare class DoubaoTTS {
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
    constructor(opts?: DoubaoTTSOptions);
    get isAvailable(): boolean;
    /** No persistent connection to tear down (fetch is stateless); kept for parity. */
    close(): Promise<void>;
    /**
     * Stream TTS audio as base64 chunks. The V3 unidirectional API returns
     * newline-delimited JSON; we parse incrementally and yield each `data`
     * field. Throws on an API error code; ends cleanly on code 20000000.
     */
    synthesizeStream(text: string): AsyncGenerator<string, void, void>;
    /** Accumulate the full audio into a single Buffer (non-streaming callers). */
    synthesize(text: string): Promise<Buffer>;
    private parseLine;
    private httpHeaders;
    private requestBody;
}
