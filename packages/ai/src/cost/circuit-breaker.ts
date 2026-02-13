/**
 * Cost Circuit Breaker
 *
 * Implements the circuit breaker pattern specifically for cost protection.
 * Automatically stops operations when cost thresholds are exceeded.
 *
 * @module cost/circuit-breaker
 */

import type {
  CircuitBreakerResult,
  CircuitBreakerState,
  CircuitState,
  CostCircuitConfig,
} from './types';

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

// ============================================
// Error Classes
// ============================================

/**
 * Error thrown when circuit breaker is open.
 */
export class CircuitBreakerError extends Error {
  readonly code = 'CIRCUIT_BREAKER_OPEN';
  readonly circuitState: CircuitState;
  readonly resetAt?: Date;

  constructor(message: string, state: CircuitState, resetAt?: Date) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.circuitState = state;
    this.resetAt = resetAt;
  }
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
 * const result = await circuitBreaker.execute(
 *   () => expensiveOperation(),
 *   estimatedCost
 * );
 *
 * if (!result.executed) {
 *   console.log('Circuit is open:', result.blockReason);
 * }
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
   * @param operation - The operation to execute
   * @param estimatedCost - Estimated cost of the operation in USD
   * @returns Execution result
   */
  async execute<T>(
    operation: () => Promise<T>,
    estimatedCost = 0
  ): Promise<CircuitBreakerResult<T>> {
    // Check if circuit should transition from open to half-open
    this.checkTimeout();

    // Check if operation should be blocked
    if (!this.shouldAllowOperation(estimatedCost)) {
      return {
        executed: false,
        circuitOpen: true,
        blockReason: this.getBlockReason(estimatedCost),
      };
    }

    try {
      const result = await operation();

      // Record success
      this.recordSuccess();
      this.cumulativeCost += estimatedCost;

      return {
        executed: true,
        result,
        circuitOpen: false,
      };
    } catch (error) {
      // Record failure
      this.recordFailure(estimatedCost);

      return {
        executed: true,
        error: error as Error,
        circuitOpen: this.state.state === 'open',
      };
    }
  }

  /**
   * Execute or throw if circuit is open.
   *
   * @param operation - The operation to execute
   * @param estimatedCost - Estimated cost of the operation
   * @returns Operation result
   * @throws CircuitBreakerError if circuit is open
   */
  async executeOrThrow<T>(
    operation: () => Promise<T>,
    estimatedCost = 0
  ): Promise<T> {
    const result = await this.execute(operation, estimatedCost);

    if (!result.executed) {
      throw new CircuitBreakerError(
        result.blockReason ?? 'Circuit breaker is open',
        this.state.state,
        this.state.resetAt
      );
    }

    if (result.error) {
      throw result.error;
    }

    return result.result!;
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

  private shouldAllowOperation(estimatedCost: number): boolean {
    const state = this.state.state;

    if (state === 'closed') {
      // Check if cost threshold would be exceeded
      if (this.cumulativeCost + estimatedCost > this.config.costThresholdUsd) {
        this.trip();
        return false;
      }
      return true;
    }

    if (state === 'half_open') {
      // Allow limited requests in half-open state
      return true;
    }

    // state === 'open'
    return false;
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

  private recordFailure(_cost: number): void {
    this.state.failureCount++;
    this.state.lastFailureAt = new Date();

    if (this.state.state === 'half_open') {
      // Any failure in half-open state opens the circuit
      this.trip();
    } else if (this.state.failureCount >= this.config.failureThreshold) {
      this.trip();
    }
  }

  private getBlockReason(estimatedCost: number): string {
    if (this.state.state === 'open') {
      const resetIn = this.state.resetAt
        ? Math.ceil((this.state.resetAt.getTime() - Date.now()) / 1000)
        : this.config.timeoutSeconds;

      return `Circuit breaker is open. Will reset in ${resetIn} seconds. Cumulative cost: $${this.cumulativeCost.toFixed(2)}`;
    }

    if (this.cumulativeCost + estimatedCost > this.config.costThresholdUsd) {
      return `Cost threshold would be exceeded. Current: $${this.cumulativeCost.toFixed(2)}, Requested: $${estimatedCost.toFixed(2)}, Threshold: $${this.config.costThresholdUsd.toFixed(2)}`;
    }

    return 'Operation blocked by circuit breaker';
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
