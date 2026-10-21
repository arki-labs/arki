import { describe, expect, it } from 'vitest';

import {
  AIError,
  ConfigurationError,
  EmbeddingError,
  GenerationError,
  ValidationError,
  VectorSearchError,
  isAIError,
} from './errors';

describe('AIError family', () => {
  it('gives each subclass its own code so a caller can branch without parsing the message', () => {
    expect(new EmbeddingError('x').code).toBe('EMBEDDING_ERROR');
    expect(new VectorSearchError('x').code).toBe('VECTOR_SEARCH_ERROR');
    expect(new GenerationError('x').code).toBe('GENERATION_ERROR');
    expect(new ValidationError('x').code).toBe('VALIDATION_ERROR');
    expect(new ConfigurationError('x').code).toBe('CONFIGURATION_ERROR');
  });

  it('keeps the cause and survives instanceof after transpilation', () => {
    const cause = new Error('socket closed');
    const error = new GenerationError('failed', cause);
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(AIError);
    expect(isAIError(error)).toBe(true);
    expect(isAIError(new Error('plain'))).toBe(false);
  });
});
