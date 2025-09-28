/**
 * Retry Manager with exponential backoff
 * Handles automatic retries for failed operations
 */

import { getErrorMessage } from '../errors';

export interface RetryConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterEnabled?: boolean;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

export class RetryManager {
  private readonly config: Required<Omit<RetryConfig, 'retryableErrors' | 'onRetry'>>;
  private readonly retryableErrors: string[];
  private readonly onRetry?: (attempt: number, error: Error, delayMs: number) => void;

  constructor(config: RetryConfig = {}) {
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      initialDelayMs: config.initialDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 30000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      jitterEnabled: config.jitterEnabled ?? true,
    };
    this.retryableErrors = config.retryableErrors ?? [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      '429', // Too Many Requests
      '500', // Internal Server Error
      '502', // Bad Gateway
      '503', // Service Unavailable
      '504', // Gateway Timeout
    ];
    this.onRetry = config.onRetry;
  }

  /**
   * Execute a function with automatic retry
   */
  async execute<T>(
    fn: () => Promise<T>,
    customConfig?: Partial<RetryConfig>
  ): Promise<RetryResult<T>> {
    const config = { ...this.config, ...customConfig };
    let lastError: Error | undefined;
    let totalDelayMs = 0;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        const data = await fn();
        return {
          success: true,
          data,
          attempts: attempt,
          totalDelayMs,
        };
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        if (!this.isRetryableError(lastError)) {
          return {
            success: false,
            error: lastError,
            attempts: attempt,
            totalDelayMs,
          };
        }

        // Last attempt failed
        if (attempt === config.maxAttempts) {
          return {
            success: false,
            error: lastError,
            attempts: attempt,
            totalDelayMs,
          };
        }

        // Calculate delay with exponential backoff
        const delayMs = this.calculateDelay(attempt, config);
        totalDelayMs += delayMs;

        // Callback before retry
        if (this.onRetry) {
          this.onRetry(attempt, lastError, delayMs);
        }

        // Wait before retrying
        await this.delay(delayMs);
      }
    }

    return {
      success: false,
      error: lastError || new Error('Retry failed'),
      attempts: config.maxAttempts,
      totalDelayMs,
    };
  }

  /**
   * Execute multiple operations with individual retry logic
   */
  async executeBatch<T>(
    operations: Array<() => Promise<T>>,
    customConfig?: Partial<RetryConfig>
  ): Promise<RetryResult<T>[]> {
    return Promise.all(
      operations.map(op => this.execute(op, customConfig))
    );
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const errorMessage = getErrorMessage(error).toLowerCase();
    const errorCode = (error as any).code || '';

    return this.retryableErrors.some(retryable => {
      const retryableLower = retryable.toLowerCase();
      return (
        errorMessage.includes(retryableLower) ||
        errorCode.toLowerCase().includes(retryableLower)
      );
    });
  }

  /**
   * Calculate delay with exponential backoff and optional jitter
   */
  private calculateDelay(
    attempt: number,
    config: Required<Omit<RetryConfig, 'retryableErrors' | 'onRetry'>>
  ): number {
    // Calculate base delay with exponential backoff
    let delayMs = Math.min(
      config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
      config.maxDelayMs
    );

    // Add jitter if enabled
    if (config.jitterEnabled) {
      const jitter = Math.random() * 0.3; // 0% to 30% jitter
      delayMs = delayMs * (1 + jitter);
    }

    return Math.floor(delayMs);
  }

  /**
   * Delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a retry-enabled wrapper for any async function
 */
export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  config?: RetryConfig
): (...args: TArgs) => Promise<TResult> {
  const retryManager = new RetryManager(config);

  return async (...args: TArgs): Promise<TResult> => {
    const result = await retryManager.execute(() => fn(...args));

    if (!result.success) {
      throw result.error;
    }

    return result.data!;
  };
}

/**
 * Global retry manager with default configuration
 */
export const defaultRetryManager = new RetryManager({
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterEnabled: true,
});

/**
 * Decorator for adding retry logic to class methods
 */
export function Retryable(config?: RetryConfig) {
  return function (
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const retryManager = new RetryManager(config);

    descriptor.value = async function (...args: any[]) {
      const result = await retryManager.execute(() =>
        originalMethod.apply(this, args)
      );

      if (!result.success) {
        throw result.error;
      }

      return result.data;
    };

    return descriptor;
  };
}