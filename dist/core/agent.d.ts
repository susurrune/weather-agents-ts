/**
 * Base agent class for all Weather Agents. Central orchestrator: tool-call
 * loop, skill activation, memory recall injection, feature detection,
 * inter-agent messaging, compaction, fact extraction. (2675-line Python, 1:1 port.)
 */
import { type MessageBus } from './bus.js';
import { type AppConfig } from './config.js';
import { type LLMClient } from './llm.js';
import { Memory } from './memory.js';
import { SkillRegistry } from './skill.js';
import { type ToolRegistry } from './tool.js';
export declare enum AgentState {
    IDLE = "idle",
    THINKING = "thinking",
    ACTING = "acting",
    WAITING = "waiting",
    ERROR = "error"
}
export declare enum TaskState {
    PENDING = "pending",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    SKIPPED = "skipped"
}
export interface TaskInit {
    id: string;
    description: string;
    assignedTo?: string | null;
    parentId?: string | null;
    dependsOn?: string[];
    status?: TaskState;
    priority?: number;
    result?: string | null;
    metadata?: Record<string, unknown>;
}
export declare class Task {
    id: string;
    description: string;
    assignedTo: string | null;
    parentId: string | null;
    dependsOn: string[];
    status: TaskState;
    priority: number;
    result: string | null;
    metadata: Record<string, unknown>;
    constructor(init: TaskInit);
    transitionTo(newState: TaskState): void;
    get allDeps(): string[];
}
export interface TaskResult {
    success: boolean;
    content: string;
    data: Record<string, unknown>;
}
export interface ChatStreamEvent {
    type: string;
    label?: string;
    text?: string;
    toolName?: string;
    toolCall?: Record<string, any>;
    args?: Record<string, any>;
    result?: string;
    success?: boolean;
    reason?: string;
}
export declare class BaseAgent {
    static readonly agentName: string;
    static readonly agentDisplayName: string;
    static readonly agentEmoji: string;
    static readonly agentSpecialty: string;
    static readonly agentSystemPrompt: string;
    static readonly agentSystemPromptEn: string;
    static readonly agentSkillNames: string[];
    readonly config: AppConfig;
    readonly llm: LLMClient;
    readonly bus: MessageBus;
    readonly toolRegistry: ToolRegistry;
    readonly skillRegistry: SkillRegistry;
    state: AgentState;
    readonly memory: Memory;
    private tools;
    private skills;
    private activeSkills;
    private skillConfigOverrides;
    private baseSystemPrompt;
    private maxToolRounds;
    private maxToolRoundsHardCap;
    private userTurnsSinceExtract;
    private pendingExtracts;
    private pendingRequests;
    private bgTasks;
    private readonly turnLock;
    private recallCache;
    /** Human-in-loop approval gate. null = auto-approve. */
    approvalCallback: ((toolName: string, toolArgs: Record<string, any>) => Promise<boolean>) | null;
    constructor(config: AppConfig, llm: LLMClient, bus: MessageBus, toolRegistry: ToolRegistry, skillRegistry?: SkillRegistry | null);
    /** Instance-level getters that read the class-level static values. */
    get name(): string;
    get displayName(): string;
    get emoji(): string;
    get specialty(): string;
    get systemPrompt(): string;
    get skillNames(): string[];
    private resolveSystemPrompt;
    private injectWorkspaceInfo;
    private currentTimeTag;
    private injectBehaviorRules;
    private injectProgrammingWisdom;
    reinitLanguage(): void;
    init(): Promise<void>;
    private loadSkills;
    private registerSkillTools;
    activateSkill(name: string): boolean;
    deactivateSkill(name: string): boolean;
    deactivateAllSkills(): void;
    private autoActivateSkills;
    private runtimeIdentityBlock;
    private rebuildSystemPrompt;
    getActiveSkills(): string[];
    getSkillConfigOverrides(): Record<string, any>;
    getAvailableSkills(): Array<{
        name: string;
        description: string;
        active: boolean;
    }>;
    close(): Promise<void>;
    private setState;
    private handleEvent;
    chatOneshot(prompt: string, opts?: {
        model?: string | null;
        temperature?: number | null;
        maxTokens?: number | null;
    }): Promise<string>;
    chat(message: string, onStatus?: ((s: string) => void) | null): Promise<string>;
    private chatImpl;
    chatStream(message: string): AsyncGenerator<ChatStreamEvent>;
    private chatStreamImpl;
    private popLastUserMessage;
    compact(keepRecent?: number): Promise<string>;
    contextUsage(): {
        estimatedTokens: number;
        maxTokens: number;
        pct: number;
        messageCount: number;
        model: string;
    };
    private shouldAutoCompact;
    private activeToolNames;
    private maybeExtractFacts;
    private extractFactsAsync;
    private parseExtractedFacts;
    private messagesWithRecall;
    private llmLoop;
    executeTask(task: Task, onStatus?: ((s: string) => void) | null): Promise<TaskResult>;
    private executeTaskImpl;
    private checkToolApproval;
    requestHelp(targetAgent: string, description: string, timeoutS?: number): Promise<string>;
    private handleRequest;
    private handleResponse;
    getStatus(): Record<string, any>;
}
