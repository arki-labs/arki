/**
 * Cost Management Module
 *
 * Provides cost tracking, budget management, and circuit breaker protection
 * for LLM and AI operations.
 *
 * @module cost
 *
 * @example
 * ```typescript
 * import {
 *   BudgetManager,
 *   CostEstimator,
 *   CostCircuitBreaker,
 *   calculateLLMCost,
 *   LLM_PRICING,
 * } from '@arki/ai/cost';
 *
 * // Create instances
 * const estimator = new CostEstimator();
 * const budgetManager = new BudgetManager(kvStore, { limits: myLimits });
 * const circuitBreaker = new CostCircuitBreaker({ costThresholdUsd: 100 });
 *
 * // Estimate cost before operation
 * const cost = estimator.estimateLLMCost('gpt-4o', 1000, 500);
 *
 * // Check budget
 * const check = await budgetManager.checkBudget(userId, cost);
 * if (!check.allowed) {
 *   throw new Error(check.rejectionReason);
 * }
 *
 * // Execute with circuit breaker protection
 * const result = await circuitBreaker.executeOrThrow(
 *   () => aiOperation(),
 *   cost
 * );
 *
 * // Record actual spend
 * await budgetManager.recordSpend(userId, actualCost, metadata);
 * ```
 */

// ============================================
// Types
// ============================================

export type {
  // Core types
  BudgetCheckResult,
  BudgetConfig,
  BudgetLimits,
  BudgetPeriod,
  CircuitBreakerResult,
  CircuitBreakerState,
  CircuitState,
  CostCircuitConfig,
  CostEstimate,
  // Pricing types
  ModelPricing,
  // KV Store interface
  KVStore,
  // Spend tracking
  SpendMetadata,
  SpendRecord,
  // Standard periods
  StandardBudgetPeriod,
} from './types';

export { BUDGET_PERIODS, CIRCUIT_STATES } from './types';

// ============================================
// Pricing
// ============================================

export {
  // Pricing data
  LLM_PRICING,
  DEFAULT_PRICING,
  // Utility functions
  getModelPricing,
  hasKnownPricing,
  calculateLLMCost,
  estimateTokens,
  estimateTokensFromWords,
  getSupportedModels,
  getModelsByProvider,
} from './pricing';

// ============================================
// Cost Estimator
// ============================================

export {
  CostEstimator,
  costEstimator,
  createCostEstimator,
} from './estimator';

// ============================================
// Budget Manager
// ============================================

export {
  BudgetManager,
  createBudgetManager,
  DEFAULT_BUDGET_LIMITS,
  BUDGET_PERIOD_DURATIONS,
} from './budget-manager';

// ============================================
// Circuit Breaker
// ============================================

export {
  CostCircuitBreaker,
  CircuitBreakerError,
  UserCircuitBreakerManager,
  createCostCircuitBreaker,
  createUserCircuitBreakerManager,
  DEFAULT_CIRCUIT_CONFIG,
} from './circuit-breaker';
