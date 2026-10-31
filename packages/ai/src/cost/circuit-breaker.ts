/**
 * Cost Circuit Breaker
 *
 * Implements the circuit breaker pattern specifically for cost protection.
 * Automatically stops operations when cost thresholds are exceeded.
 *
 * @module cost/circuit-breaker
 */

import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { CIRCUIT_OPEN_REASONS } from '../failures';
import type { CircuitBreakerState, CircuitState, CostCircuitConfig } from './types';
import { Cancelled, CircuitOpen } from '../failures';

// ============================================
// Default Configuration
// ============================================

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_CONFIG: CostCircuitConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  timeoutSeconds: 60,
  costThresholdUsd: 10,
};

/** An abort raised by `fetch` or the AI SDK: a DOM `AbortError`, or the `TimeoutError` of `AbortSignal.timeout`. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

// ============================================
// Cost Circuit Breaker Class
// ============================================

/**
 * Circuit breaker that trips based on cost thresholds.
 *
 * States:
 * - closed: Normal operation, requests flow through
 * - open: Circuit is tripped, requests are blocked
 * - half_open: Testing if service has recovered
 *
 * @example
 * ```typescript
 * const circuitBreaker = new CostCircuitBreaker({
 *   costThresholdUsd: 50,
 *   failureThreshold: 3,
 *   timeoutSeconds: 300,
 * });
 *
 * // Execute with circuit breaker protection
 * const result = await circuitBreaker.execute(() => expensiveOperation(), estimatedCost);
 * if (CircuitOpen.is(result)) return result; // the operation did not run
 * ```
 */
export class CostCircuitBreaker {
  private state: CircuitBreakerState;
  private readonly config: CostCircuitConfig;
  private cumulativeCost = 0;

  constructor(config: Partial<CostCircuitConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    this.state = this.createInitialState();
  }

  // ============================================
  // Circuit Execution
  // ============================================

  /**
   * Execute an operation with circuit breaker protection.
   *
   * The operation returns its expected failures (an `@arki/failure` value), it does not throw them.
   * A returned failure counts toward `failureThreshold`, except `Cancelled` (the caller gave up)
   * and `UnexpectedDefect` (a bug, not an outage). A throw is never counted: an abort becomes
   * `Cancelled`, anything else `UnexpectedDefect`.
   *
   * @param operation - The operation to execute
   * @param estimatedCost - Estimated cost of the operation in USD
   * @returns The operation's own result (success or returned failure), `CircuitOpen` when the
   *   breaker refused to run it, or `Cancelled` / `UnexpectedDefect` when it threw
   */
  async execute<T>(
    operation: () => Promise<T>,
    estimatedCost = 0
  ): Promise<T | CircuitOpen | Cancelled | ReturnType<typeof UnexpectedDefect>> {
    // Check if circuit should transition from open to half-open
    this.checkTimeout();

    const refusal = this.refusalFor(estimatedCost);
    if (refusal !== undefined) return refusal;

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      // A throw is not an expected outcome of the operation: it never trips the breaker.
      return isAbort(error) ? Cancelled({ cause: error }) : UnexpectedDefect({ cause: error });
    }

    // Widened to `unknown` only to ask whether the result is a failure; the caller still gets `result` as `T`.
    const outcome: unknown = result;
    if (isFailure(outcome)) {
      if (!Cancelled.is(outcome) && !UnexpectedDefect.is(outcome)) this.recordFailure();
      return result;
    }

    this.recordSuccess();
    this.cumulativeCost += estimatedCost;
    return result;
  }

  // ============================================
  // State Management
  // ============================================

  /**
   * Get current circuit state.
   */
  getState(): CircuitBreakerState {
    this.checkTimeout();
    return { ...this.state };
  }

  /**
   * Get cumulative cost tracked by this circuit.
   */
  getCumulativeCost(): number {
    return this.cumulativeCost;
  }

  /**
   * Check if the circuit is currently open.
   */
  isOpen(): boolean {
    this.checkTimeout();
    return this.state.state === 'open';
  }

  /**
   * Check if the circuit is closed (normal operation).
   */
  isClosed(): boolean {
    this.checkTimeout();
    return this.state.state === 'closed';
  }

  /**
   * Manually trip the circuit (force open).
   *
   * @param _reason - Reason for tripping (optional, for logging)
   */
  trip(_reason?: string): void {
    this.state = {
      state: 'open',
      failureCount: this.config.failureThreshold,
      successCount: 0,
      lastFailureAt: new Date(),
      resetAt: new Date(Date.now() + this.config.timeoutSeconds * 1000),
      triggeringCostUsd: this.cumulativeCost,
    };
  }

  /**
   * Manually reset the circuit (force closed).
   */
  reset(): void {
    this.state = this.createInitialState();
    this.cumulativeCost = 0;
  }

  // ============================================
  // Internal Methods
  // ============================================

  private createInitialState(): CircuitBreakerState {
    return {
      state: 'closed',
      failureCount: 0,
      successCount: 0,
    };
  }

  /** `CircuitOpen` when this call must not run; trips the breaker when the call would cross the cost threshold. */
  private refusalFor(estimatedCost: number): CircuitOpen | undefined {
    const state = this.state.state;

    if (state === 'closed' && this.cumulativeCost + estimatedCost > this.config.costThresholdUsd) {
      this.trip();
      return this.openFailure('cost_threshold');
    }

    // half_open lets calls through to test recovery
    if (state === 'open') return this.openFailure('open');
    return undefined;
  }

  private openFailure(reason: (typeof CIRCUIT_OPEN_REASONS)[number]): CircuitOpen {
    const retryAfterMs =
      this.state.resetAt === undefined
        ? this.config.timeoutSeconds * 1000
        : Math.max(0, this.state.resetAt.getTime() - Date.now());
    return CircuitOpen({
      reason,
      retryAfterMs,
      cumulativeCostUsd: this.cumulativeCost,
      costThresholdUsd: this.config.costThresholdUsd,
    });
  }

  private checkTimeout(): void {
    if (this.state.state === 'open' && this.state.resetAt && new Date() >= this.state.resetAt) {
        // Transition to half-open
        this.state = {
          ...this.state,
          state: 'half_open',
          successCount: 0,
        };
      }
  }

  private recordSuccess(): void {
    if (this.state.state === 'half_open') {
      this.state.successCount++;

      // If enough successes, close the circuit
      if (this.state.successCount >= this.config.successThreshold) {
        this.state = {
          state: 'closed',
          failureCount: 0,
          successCount: 0,
        };
        // Reset cumulative cost when circuit closes
        this.cumulativeCost = 0;
      }
    } else if (this.state.state === 'closed') {
      // Reset failure count on success
      this.state.failureCount = 0;
    }
  }

  private recordFailure(): void {
    this.state.failureCount++;
    this.state.lastFailureAt = new Date();

    if (this.state.state === 'half_open') {
      // Any failure in half-open state opens the circuit
      this.trip();
    } else if (this.state.failureCount >= this.config.failureThreshold) {
      this.trip();
    }
  }

}

// ============================================
// Per-User Circuit Breaker Manager
// ============================================

/**
 * Manages circuit breakers per user.
 *
 * Provides isolated circuit breaker instances for each user,
 * preventing one user's issues from affecting others.
 *
 * @example
 * ```typescript
 * const manager = new UserCircuitBreakerManager({
 *   costThresholdUsd: 100,
 *   timeoutSeconds: 300,
 * });
 *
 * // Get user-specific circuit breaker
 * const userCircuit = manager.getForUser(userId);
 * await userCircuit.execute(() => operation(), cost);
 * ```
 */
export class UserCircuitBreakerManager {
  private readonly circuits = new Map<string, CostCircuitBreaker>();
  private readonly config: Partial<CostCircuitConfig>;

  constructor(config: Partial<CostCircuitConfig> = {}) {
    this.config = config;
  }

  /**
   * Get or create circuit breaker for a user.
   *
   * @param userId - User identifier
   * @returns User's circuit breaker
   */
  getForUser(userId: string): CostCircuitBreaker {
    let circuit = this.circuits.get(userId);

    if (!circuit) {
      circuit = new CostCircuitBreaker(this.config);
      this.circuits.set(userId, circuit);
    }

    return circuit;
  }

  /**
   * Reset circuit breaker for a user.
   *
   * @param userId - User identifier
   */
  resetUser(userId: string): void {
    const circuit = this.circuits.get(userId);
    if (circuit) {
      circuit.reset();
    }
  }

  /**
   * Remove circuit breaker for a user (cleanup).
   *
   * @param userId - User identifier
   */
  removeUser(userId: string): void {
    this.circuits.delete(userId);
  }

  /**
   * Get all users with open circuits.
   *
   * @returns Array of user IDs with open circuits
   */
  getOpenCircuits(): string[] {
    const openUsers: string[] = [];

    for (const [userId, circuit] of this.circuits) {
      if (circuit.isOpen()) {
        openUsers.push(userId);
      }
    }

    return openUsers;
  }

  /**
   * Get status of all circuit breakers.
   */
  getAllStatus(): {
    userId: string;
    state: CircuitState;
    cumulativeCost: number;
  }[] {
    return [...this.circuits.entries()].map(([userId, circuit]) => ({
      userId,
      state: circuit.getState().state,
      cumulativeCost: circuit.getCumulativeCost(),
    }));
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a cost circuit breaker.
 *
 * @param config - Configuration options
 * @returns Configured circuit breaker
 */
export function createCostCircuitBreaker(
  config?: Partial<CostCircuitConfig>
): CostCircuitBreaker {
  return new CostCircuitBreaker(config);
}

/**
 * Create a user circuit breaker manager.
 *
 * @param config - Configuration options
 * @returns Configured manager
 */
export function createUserCircuitBreakerManager(
  config?: Partial<CostCircuitConfig>
): UserCircuitBreakerManager {
  return new UserCircuitBreakerManager(config);
}
