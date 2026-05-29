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
export declare enum CircuitState {
    CLOSED = "closed",
    OPEN = "open",
    HALF_OPEN = "half_open"
}
export declare class CircuitBreaker {
    readonly name: string;
    readonly failureThreshold: number;
    readonly recoveryTimeout: number;
    state: CircuitState;
    private _failureCount;
    private _lastFailureTime;
    constructor(name: string, failureThreshold?: number, recoveryTimeout?: number);
    get failureCount(): number;
    allowRequest(): boolean;
    recordSuccess(): void;
    recordFailure(): void;
    reset(): void;
    /** Internal accessor used by breakerStates(); not part of the public API. */
    get _rawFailureCount(): number;
}
/** Get or create a circuit breaker for a tool by name. */
export declare function getBreaker(name: string, opts?: {
    failureThreshold?: number;
    recoveryTimeout?: number;
}): CircuitBreaker;
export declare function resetAllBreakers(): void;
/** Snapshot of all breaker states for display / monitoring. */
export declare function breakerStates(): Record<string, string>;
