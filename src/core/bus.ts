/** Async event-driven message bus for inter-agent communication. */

import { getLogger } from './logger.js';

const log = getLogger('bus');

export enum EventType {
  TASK_ASSIGNED = 'task_assigned',
  TASK_COMPLETED = 'task_completed',
  TASK_FEEDBACK = 'task_feedback',
  AGENT_REQUEST = 'agent_request',
  AGENT_RESPONSE = 'agent_response',
  SYSTEM_EVENT = 'system_event',
  STATE_CHANGE = 'state_change', // agent state changes
  LLM_CALL = 'llm_call', // LLM request made
  TOOL_CALL = 'tool_call', // tool was called
}

export interface Event {
  type: EventType;
  source: string; // agent name or "system"
  target?: string | null; // null/undefined = broadcast
  data: Record<string, unknown>;
  timestamp: Date;
}

/** Construct an Event with sensible defaults (mirrors the Python dataclass). */
export function makeEvent(
  type: EventType,
  source: string,
  opts: { target?: string | null; data?: Record<string, unknown> } = {},
): Event {
  return {
    type,
    source,
    target: opts.target ?? null,
    data: opts.data ?? {},
    timestamp: new Date(),
  };
}

export type Handler = (event: Event) => Promise<void>;

/** Pub/sub message bus for agent communication. */
export class MessageBus {
  private readonly subscribers = new Map<string, Handler[]>();
  private readonly stateListeners: Handler[] = [];
  private history: Event[] = [];
  private readonly maxHistory = 2000;

  subscribe(agentName: string, handler: Handler): void {
    const list = this.subscribers.get(agentName);
    if (list) {
      list.push(handler);
    } else {
      this.subscribers.set(agentName, [handler]);
    }
  }

  unsubscribe(agentName: string): void {
    this.subscribers.delete(agentName);
  }

  /** Register a global handler for state change events. */
  onStateChange(handler: Handler): void {
    this.stateListeners.push(handler);
  }

  removeStateListener(handler: Handler): void {
    const idx = this.stateListeners.indexOf(handler);
    if (idx >= 0) {
      this.stateListeners.splice(idx, 1);
    }
  }

  private trimHistory(): void {
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }

  /** Record event without routing (for state changes / local observation). */
  addEvent(event: Event): void {
    this.history.push(event);
    this.trimHistory();
  }

  /** Notify state change listeners (must be called from async context). */
  async notifyStateChange(event: Event): Promise<void> {
    if (event.type !== EventType.STATE_CHANGE) {
      return;
    }
    for (const handler of this.stateListeners) {
      try {
        await handler(event);
      } catch (e) {
        log.exception('state_change handler failed', e);
      }
    }
  }

  async publish(event: Event): Promise<void> {
    this.history.push(event);
    this.trimHistory();

    if (event.target) {
      // Direct message
      const handlers = this.subscribers.get(event.target) ?? [];
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (e) {
          log.exception(`bus handler failed for target=${event.target}`, e);
        }
      }
    } else {
      // Broadcast
      for (const [name, handlers] of this.subscribers.entries()) {
        if (name === event.source) {
          continue;
        }
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (e) {
            log.exception(`bus handler failed for subscriber=${name}`, e);
          }
        }
      }
    }
  }

  getHistory(
    opts: { agentName?: string | null; eventType?: EventType | null; limit?: number } = {},
  ): Event[] {
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
