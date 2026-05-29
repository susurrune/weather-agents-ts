/**
 * Per-tool circuit breaker — fail-fast on cascading errors.
 *
 * Three states:
 *   CLOSED    Normal operation — passes all requests.
 *   OPEN      Failures exceeded threshold — requests rejected immediately.
 *   HALF_OPEN Cooldown expired — one probe request to test recovery.
 *
 * Usage:
 *   const breaker = getBreaker('write_file');
 *   if (!breaker.allowRequest()) return 'tool temporarily unavailable';
 *   try {
 *     const result = await handler(args);
 *     breaker.recordSuccess();
 *   } catch {
 *     breaker.recordFailure();
 *   }
 */

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/** Monotonic clock in seconds (mirrors Python time.monotonic). */
function monotonic(): number {
  return performance.now() / 1000;
}

export class CircuitBreaker {
  readonly name: string;
  readonly failureThreshold: number;
  readonly recoveryTimeout: number;
  state: CircuitState = CircuitState.CLOSED;
  private _failureCount = 0;
  private _lastFailureTime = 0;

  constructor(name: string, failureThreshold = 3, recoveryTimeout = 30.0) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
  }

  get failureCount(): number {
    return this._failureCount;
  }

  allowRequest(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }
    if (this.state === CircuitState.OPEN) {
      if (monotonic() - this._lastFailureTime >= this.recoveryTimeout) {
        this.state = CircuitState.HALF_OPEN;
        return true;
      }
      return false;
    }
    // HALF_OPEN — allow one probe
    // KNOWN LIMITATION: under concurrent callers, all of them pass
    // through during HALF_OPEN until success/failure resolves the
    // breaker (thundering herd). The existing test
    // `half_open_allows_all_until_decision` locks in this contract;
    // tightening it to true single-probe semantics needs a coordinated
    // change to that test.
    return true;
  }

  recordSuccess(): void {
    this._failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
    }
  }

  recordFailure(): void {
    this._failureCount += 1;
    this._lastFailureTime = monotonic();
    if (this._failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this._failureCount = 0;
    this._lastFailureTime = 0;
  }

  /** Internal accessor used by breakerStates(); not part of the public API. */
  get _rawFailureCount(): number {
    return this._failureCount;
  }
}

// Global per-tool circuit breaker registry
const _BREAKERS = new Map<string, CircuitBreaker>();

/** Get or create a circuit breaker for a tool by name. */
export function getBreaker(
  name: string,
  opts: { failureThreshold?: number; recoveryTimeout?: number } = {},
): CircuitBreaker {
  let breaker = _BREAKERS.get(name);
  if (breaker === undefined) {
    breaker = new CircuitBreaker(name, opts.failureThreshold ?? 3, opts.recoveryTimeout ?? 30.0);
    _BREAKERS.set(name, breaker);
  }
  return breaker;
}

export function resetAllBreakers(): void {
  for (const b of _BREAKERS.values()) {
    b.reset();
  }
}

/** Snapshot of all breaker states for display / monitoring. */
export function breakerStates(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, b] of _BREAKERS.entries()) {
    if (b._rawFailureCount > 0 || b.state !== CircuitState.CLOSED) {
      out[name] = b.state;
    }
  }
  return out;
}
