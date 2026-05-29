/** Async event-driven message bus for inter-agent communication. */
export declare enum EventType {
    TASK_ASSIGNED = "task_assigned",
    TASK_COMPLETED = "task_completed",
    TASK_FEEDBACK = "task_feedback",
    AGENT_REQUEST = "agent_request",
    AGENT_RESPONSE = "agent_response",
    SYSTEM_EVENT = "system_event",
    STATE_CHANGE = "state_change",// agent state changes
    LLM_CALL = "llm_call",// LLM request made
    TOOL_CALL = "tool_call"
}
export interface Event {
    type: EventType;
    source: string;
    target?: string | null;
    data: Record<string, unknown>;
    timestamp: Date;
}
/** Construct an Event with sensible defaults (mirrors the Python dataclass). */
export declare function makeEvent(type: EventType, source: string, opts?: {
    target?: string | null;
    data?: Record<string, unknown>;
}): Event;
export type Handler = (event: Event) => Promise<void>;
/** Pub/sub message bus for agent communication. */
export declare class MessageBus {
    private readonly subscribers;
    private readonly stateListeners;
    private history;
    private readonly maxHistory;
    subscribe(agentName: string, handler: Handler): void;
    unsubscribe(agentName: string): void;
    /** Register a global handler for state change events. */
    onStateChange(handler: Handler): void;
    removeStateListener(handler: Handler): void;
    private trimHistory;
    /** Record event without routing (for state changes / local observation). */
    addEvent(event: Event): void;
    /** Notify state change listeners (must be called from async context). */
    notifyStateChange(event: Event): Promise<void>;
    publish(event: Event): Promise<void>;
    getHistory(opts?: {
        agentName?: string | null;
        eventType?: EventType | null;
        limit?: number;
    }): Event[];
}
