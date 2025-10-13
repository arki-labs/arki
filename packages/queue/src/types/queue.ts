/**
 * Queue configuration types
 */

/**
 * Queue metadata type
 * Can be extended by users to add custom metadata
 */
export type QueueMeta = Record<string, unknown>;

/**
 * Error formatter function
 */
export type ErrorFormatter<TError = Error> = (error: TError) => unknown;

/**
 * Data transformer
 * Used to serialize/deserialize job data
 */
export type DataTransformer = {
  serialize: (data: unknown) => unknown;
  deserialize: (data: unknown) => unknown;
};

/**
 * Queue configuration
 */
export type QueueConfig = {
  /**
   * Data transformer for serializing job data
   * Default: superjson
   */
  transformer?: DataTransformer;

  /**
   * Error formatter for standardizing error responses
   */
  errorFormatter?: ErrorFormatter;

  /**
   * Whether we're in development mode
   * Used for additional logging, error details, etc.
   */
  isDev?: boolean;
};
