/** Memory system: short-term context, long-term persistence, working memory. */
import type { MemoryConfig } from './config.js';
type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;
export interface Message {
    role: string;
    content: string;
    name?: string | null;
    toolCallId?: string | null;
    toolCalls?: Array<Record<string, any>> | null;
    reasoningContent?: string | null;
}
export interface MessageDict {
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<Record<string, any>>;
    reasoning_content?: string;
}
/**
 * Three-layer memory for each agent with SQLite persistence.
 *
 * - Short-term: conversation context (persisted to SQLite)
 * - Working: in-memory task-scoped state (persisted)
 * - Long-term: persistent key-value storage with search
 *
 * Backed by Node's built-in synchronous `node:sqlite`. Public methods stay
 * async to mirror the Python (aiosqlite) interface the agent layer awaits;
 * DB calls are synchronous internally so there is no task-scheduling /
 * pending-flush bookkeeping the Python version needed.
 */
export declare class Memory {
    readonly config: MemoryConfig;
    readonly agentName: string;
    shortTerm: Message[];
    working: Record<string, any>;
    private readonly dbPath;
    private db;
    private loaded;
    private activeSession;
    constructor(config: MemoryConfig, agentName: string);
    initDb(): Promise<void>;
    /** Run a statement, swallowing errors (used for idempotent migrations). */
    private tryExec;
    private run;
    private all;
    private get;
    private loadShortTerm;
    /**
     * Keep only the contiguous newest-first tail of rows where consecutive
     * created_at values are within gapSeconds of each other.
     */
    static truncateAtTimestampGap(rows: Row[], gapSeconds: number): Row[];
    /**
     * Remove orphaned tool_calls/tool message pairs from short-term memory.
     *
     * Every 'tool' message must be preceded by an 'assistant' whose tool_calls
     * contains the matching id. Position-aware: each tool message satisfies the
     * CLOSEST preceding assistant carrying its id (handles duplicate ids).
     */
    pruneDanglingToolCalls(): void;
    /** Public wrapper around pruneDanglingToolCalls. */
    pruneToolMessages(): void;
    close(): Promise<void>;
    addMessage(role: string, content: string, opts?: {
        name?: string | null;
        toolCallId?: string | null;
        toolCalls?: Array<Record<string, any>> | null;
        reasoningContent?: string | null;
        ephemeral?: boolean;
    }): void;
    private persistMessage;
    getMessages(): MessageDict[];
    getContextWindowUsage(): {
        message_count: number;
        total_chars: number;
        estimated_tokens: number;
        limit: number;
    };
    clearShortTerm(): Promise<void>;
    private loadWorking;
    private persistWorking;
    setWorking(key: string, value: any): void;
    getWorking(key: string, defaultValue?: any): any;
    clearWorking(): void;
    remember(key: string, value: any, category?: string): Promise<void>;
    recall(opts?: {
        key?: string | null;
        category?: string | null;
        limit?: number;
    }): Promise<Array<{
        key: string;
        value: any;
        category: string;
    }>>;
    forget(key: string): Promise<void>;
    /**
     * Split `query` into recall tokens. ASCII words (length >= 2) first (high
     * signal), then CJK 2-/3-grams. Unique, priority-preserving.
     */
    static tokenizeForRecall(query: string): string[];
    /**
     * Find long-term facts whose key OR value matches tokens from `query`.
     * Two passes: fast LIKE token scan, then semantic n-gram scoring on recent
     * facts. Returns at most `limit` distinct facts by combined relevance.
     */
    recallForInjection(query: string, limit?: number): Promise<Array<{
        key: string;
        value: any;
        category: string;
    }>>;
    /** Render facts as a compact markdown block for prompt injection. */
    static formatFactsBlock(facts: Array<{
        key: string;
        value: any;
    }>): string;
    getActiveSession(): string | null;
    createSession(name?: string | null): Promise<string>;
    listSessions(): Promise<Array<{
        id: string;
        agent: string;
        name: string | null;
        preview: string;
        message_count: number;
        created_at: string;
        updated_at: string;
    }>>;
    resumeLatestSession(): Promise<string | null>;
    loadSession(sessionId: string): Promise<boolean>;
    deleteSession(sessionId: string): Promise<boolean>;
    updateSessionPreview(): Promise<void>;
    getMemoryStats(): Promise<{
        total: number;
        categories: Record<string, number>;
    }>;
}
export {};
