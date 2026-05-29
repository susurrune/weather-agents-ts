import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitState, getBreaker } from '../src/core/circuitBreaker.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CircuitBreaker', () => {
  it('starts CLOSED and allows requests', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.allowRequest()).toBe(true);
  });

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker('test', 3);
    for (let i = 0; i < 3; i++) cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.allowRequest()).toBe(false);
  });

  it('stays closed below threshold', () => {
    const cb = new CircuitBreaker('test', 5);
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.allowRequest()).toBe(true);
  });

  it('records success resets count', () => {
    const cb = new CircuitBreaker('test', 3);
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.failureCount).toBe(0);
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  it('transitions to HALF_OPEN after timeout', async () => {
    const cb = new CircuitBreaker('test', 2, 0.05);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.allowRequest()).toBe(false);
    await sleep(60);
    expect(cb.allowRequest()).toBe(true);
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
  });

  it('HALF_OPEN success closes', async () => {
    const cb = new CircuitBreaker('test', 2, 0.05);
    cb.recordFailure();
    cb.recordFailure();
    await sleep(60);
    cb.allowRequest();
    cb.recordSuccess();
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  it('HALF_OPEN failure reopens', async () => {
    const cb = new CircuitBreaker('test', 2, 0.05);
    cb.recordFailure();
    cb.recordFailure();
    await sleep(60);
    cb.allowRequest();
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
  });

  it('HALF_OPEN allows all until decision (locked contract)', async () => {
    const cb = new CircuitBreaker('race', 1, 0.05);
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    await sleep(60);
    const results = Array.from({ length: 10 }, () => cb.allowRequest());
    expect(results.every((r) => r)).toBe(true);
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.allowRequest()).toBe(false);
  });

  it('reset returns to CLOSED', () => {
    const cb = new CircuitBreaker('test', 1);
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    cb.reset();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.failureCount).toBe(0);
    expect(cb.allowRequest()).toBe(true);
  });

  it('getBreaker returns a singleton per name', () => {
    const a1 = getBreaker('my_tool');
    const a2 = getBreaker('my_tool');
    expect(a1).toBe(a2);
    const b = getBreaker('other_tool');
    expect(a1).not.toBe(b);
  });
});
