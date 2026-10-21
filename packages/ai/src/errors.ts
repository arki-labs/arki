import type { StandardSchemaV1 } from '@arki/schema';

/**
 * Custom error classes for @arki/ai
 */

/**
 * Base error class for all AI-related errors. Read `code` to tell them apart.
 * @fix Read `code` and `cause`, then fix the call or the configuration that the subclass names.
 * @verify bun run test -- src/errors.test.ts
 */
export class AIError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AIError';
    Object.setPrototypeOf(this, AIError.prototype);
  }
}

/**
 * Error thrown when embedding generation fails
 * @fix Check the embedding provider's key, model and dimensions, and that the service answers.
 * @verify bun run test -- src/errors.test.ts
 */
export class EmbeddingError extends AIError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EMBEDDING_ERROR', cause);
    this.name = 'EmbeddingError';
    Object.setPrototypeOf(this, EmbeddingError.prototype);
  }
}

/**
 * Error thrown when vector search operations fail
 * @fix Check that the vector store (for example Qdrant at `QDRANT_URL`) is up and the collection exists.
 * @verify bun run test -- src/errors.test.ts
 */
export class VectorSearchError extends AIError {
  constructor(message: string, cause?: unknown) {
    super(message, 'VECTOR_SEARCH_ERROR', cause);
    this.name = 'VectorSearchError';
    Object.setPrototypeOf(this, VectorSearchError.prototype);
  }
}

/**
 * Error thrown when AI generation fails
 * @fix Check the provider's key and model, and that the service (for example Ollama) answers.
 * @verify bun run test -- src/errors.test.ts
 */
export class GenerationError extends AIError {
  constructor(message: string, cause?: unknown) {
    super(message, 'GENERATION_ERROR', cause);
    this.name = 'GenerationError';
    Object.setPrototypeOf(this, GenerationError.prototype);
  }
}

/**
 * Error thrown when input validation fails
 * @fix Read `validationErrors`, then change the input so each field passes its schema.
 * @verify bun run test -- src/errors.test.ts
 */
export class ValidationError extends AIError {
  constructor(
    message: string,
    public readonly validationErrors?: { field: string; message: string }[]
  ) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Error thrown when API configuration is invalid
 * @fix Set the environment variable or option the message names, then start again.
 * @verify bun run test -- src/errors.test.ts
 */
export class ConfigurationError extends AIError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

/**
 * A tool returned a result that does not match its `output` schema. The runtime throws it in
 * place of the result, so the model never sees the bad value.
 * @fix Change the `execute` of the named tool so its result matches its `output` schema.
 * @verify bun run test -- src/runtime/ai-sdk-runtime.test.ts
 */
export class ToolOutputError extends AIError {
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(
    /** The tool's name. */
    readonly tool: string,
    /** What the output schema rejected. */
    readonly issues: readonly StandardSchemaV1.Issue[],
  ) {
    super(
      `Tool "${tool}" returned a result that does not match its output schema: ${issues.map(issue => issue.message).join('; ')}`,
      'TOOL_OUTPUT_ERROR',
    );
    this.name = 'ToolOutputError';
    this.remediation = `Change the execute of tool "${tool}" so it returns a value that matches its output schema.`;
    Object.setPrototypeOf(this, ToolOutputError.prototype);
  }
}

/**
 * Type guard to check if error is an AIError
 */
export function isAIError(error: unknown): error is AIError {
  return error instanceof AIError;
}

/**
 * Type guard to check if error has a message property
 */
export function hasErrorMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>)['message'] === 'string'
  );
}

/**
 * Safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (hasErrorMessage(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
}

/**
 * Error logging interface (to be implemented by consumer)
 */
export type ErrorLogger = {
  logError(error: AIError): void;
  logWarning(message: string, context?: Record<string, unknown>): void;
}