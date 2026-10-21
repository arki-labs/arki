import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type { EmbedOptions, EmbeddingSpace, TokenCount } from './types.js';
import type { embedRequestSchema, spaceSchema, tokenCountSchema } from './schemas.js';

describe('schemas', () => {
  // The types are the source; a schema that drifts from them would accept files the types reject.
  it('each schema outputs exactly its type', () => {
    expectTypeOf<z.output<typeof spaceSchema>>().toEqualTypeOf<EmbeddingSpace>();
    expectTypeOf<z.output<typeof tokenCountSchema>>().toEqualTypeOf<TokenCount>();
    type RecordedOptions = Omit<z.output<typeof embedRequestSchema>, 'inputs'>;
    expectTypeOf<RecordedOptions>().toEqualTypeOf<Pick<EmbedOptions, 'purpose' | 'dimensions' | 'quantization' | 'onTooLong'>>();
    expectTypeOf<z.output<typeof embedRequestSchema>['inputs']>().toEqualTypeOf<readonly string[]>();
  });
});
