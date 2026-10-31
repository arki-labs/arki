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
 *   BudgetExceeded,
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
 * // Check budget: nothing, or the BudgetExceeded failure
 * const exceeded = await budgetManager.checkBudget(userId, cost);
 * if (BudgetExceeded.is(exceeded)) return exceeded;
 *
 * // Execute with circuit breaker protection
 * const result = await circuitBreaker.execute(() => aiOperation(), cost);
 * if (CircuitOpen.is(result)) return result; // refused: the operation did not run
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
  BudgetConfig,
  BudgetLimits,
  BudgetPeriod,
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
  priceOf,
  isLocalProvider,
  LOCAL_PROVIDERS,
  PRICE_BASES,
  estimateTokens,
  estimateTokensFromWords,
  getSupportedModels,
  getModelsByProvider,
} from './pricing';
export type { Price, PriceBasis, PricedCall } from './pricing';

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

export { BudgetExceeded, CIRCUIT_OPEN_REASONS, CircuitOpen } from '../failures';

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
  UserCircuitBreakerManager,
  createCostCircuitBreaker,
  createUserCircuitBreakerManager,
  DEFAULT_CIRCUIT_CONFIG,
} from './circuit-breaker';
