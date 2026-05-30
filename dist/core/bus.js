/** Async event-driven message bus for inter-agent communication. */
import { getLogger } from './logger.js';
const log = getLogger('bus');
export var EventType;
(function (EventType) {
    EventType["TASK_ASSIGNED"] = "task_assigned";
    EventType["TASK_COMPLETED"] = "task_completed";
    EventType["TASK_FEEDBACK"] = "task_feedback";
    EventType["AGENT_REQUEST"] = "agent_request";
    EventType["AGENT_RESPONSE"] = "agent_response";
    EventType["SYSTEM_EVENT"] = "system_event";
    EventType["STATE_CHANGE"] = "state_change";
    EventType["LLM_CALL"] = "llm_call";
    EventType["TOOL_CALL"] = "tool_call";
})(EventType || (EventType = {}));
/** Construct an Event with sensible defaults (mirrors the Python dataclass). */
export function makeEvent(type, source, opts = {}) {
    return {
        type,
        source,
        target: opts.target ?? null,
        data: opts.data ?? {},
        timestamp: new Date(),
    };
}
/** Pub/sub message bus for agent communication. */
export class MessageBus {
    subscribers = new Map();
    stateListeners = [];
    history = [];
    maxHistory = 2000;
    subscribe(agentName, handler) {
        const list = this.subscribers.get(agentName);
        if (list) {
            list.push(handler);
        }
        else {
            this.subscribers.set(agentName, [handler]);
        }
    }
    unsubscribe(agentName) {
        this.subscribers.delete(agentName);
    }
    /** Register a global handler for state change events. */
    onStateChange(handler) {
        this.stateListeners.push(handler);
    }
    removeStateListener(handler) {
        const idx = this.stateListeners.indexOf(handler);
        if (idx >= 0) {
            this.stateListeners.splice(idx, 1);
        }
    }
    trimHistory() {
        if (this.history.length > this.maxHistory) {
            this.history.splice(0, this.history.length - this.maxHistory);
        }
    }
    /** Record event without routing (for state changes / local observation). */
    addEvent(event) {
        this.history.push(event);
        this.trimHistory();
    }
    /** Notify state change listeners (must be called from async context). */
    async notifyStateChange(event) {
        if (event.type !== EventType.STATE_CHANGE) {
            return;
        }
        for (const handler of this.stateListeners) {
            try {
                await handler(event);
            }
            catch (e) {
                log.exception('state_change handler failed', e);
            }
        }
    }
    async publish(event) {
        this.history.push(event);
        this.trimHistory();
        if (event.target) {
            // Direct message
            const handlers = this.subscribers.get(event.target) ?? [];
            for (const handler of handlers) {
                try {
                    await handler(event);
                }
                catch (e) {
                    log.exception(`bus handler failed for target=${event.target}`, e);
                }
            }
        }
        else {
            // Broadcast
            for (const [name, handlers] of this.subscribers.entries()) {
                if (name === event.source) {
                    continue;
                }
                for (const handler of handlers) {
                    try {
                        await handler(event);
                    }
                    catch (e) {
                        log.exception(`bus handler failed for subscriber=${name}`, e);
                    }
                }
            }
        }
    }
    getHistory(opts = {}) {
        const { agentName = null, eventType = null, limit = 50 } = opts;
        let events = this.history;
        if (agentName) {
            events = events.filter((e) => e.source === agentName || e.target === agentName);
        }
        if (eventType) {
            events = events.filter((e) => e.type === eventType);
        }
        return events.slice(-limit);
    }
}
