import { describe, it, expect } from 'vitest';
import { MessageBus, EventType, makeEvent } from '../src/core/bus.js';

describe('MessageBus', () => {
  it('delivers direct messages to the target subscriber', async () => {
    const bus = new MessageBus();
    const got: string[] = [];
    bus.subscribe('fog', async (e) => {
      got.push(String(e.data.payload));
    });
    await bus.publish(
      makeEvent(EventType.AGENT_REQUEST, 'snow', { target: 'fog', data: { payload: 'x' } }),
    );
    expect(got).toEqual(['x']);
  });

  it('broadcast skips the source agent', async () => {
    const bus = new MessageBus();
    const seen: string[] = [];
    bus.subscribe('fog', async () => {
      seen.push('fog');
    });
    bus.subscribe('rain', async () => {
      seen.push('rain');
    });
    await bus.publish(makeEvent(EventType.SYSTEM_EVENT, 'fog'));
    expect(seen).toEqual(['rain']);
  });

  it('isolates handler failures', async () => {
    const bus = new MessageBus();
    let reached = false;
    bus.subscribe('a', async () => {
      throw new Error('boom');
    });
    bus.subscribe('a', async () => {
      reached = true;
    });
    await bus.publish(makeEvent(EventType.SYSTEM_EVENT, 'sys', { target: 'a' }));
    expect(reached).toBe(true);
  });

  it('filters history by agent and type', async () => {
    const bus = new MessageBus();
    await bus.publish(makeEvent(EventType.TASK_ASSIGNED, 'snow', { target: 'fog' }));
    await bus.publish(makeEvent(EventType.TASK_COMPLETED, 'fog', { target: 'snow' }));
    expect(bus.getHistory({ agentName: 'fog' })).toHaveLength(2);
    expect(bus.getHistory({ eventType: EventType.TASK_ASSIGNED })).toHaveLength(1);
  });
});
