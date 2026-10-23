import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { CommandConflict, CommandFailure, CommandInvalid, CommandNotFound } from '../errors.js';
import type { MetadataContext, RunMetadata, TagsContext } from './run-fields.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
type Refusal = CommandNotFound | CommandConflict | CommandInvalid | CommandFailure;

describe('ctx.metadata and ctx.tags, as types', () => {
  it('a step and an undo both get them, each call answering with the change or its refusal', () => {
    j.workflow('changes', { version: 1, input: z.object({}) })
      .step(
        'work',
        async ({ metadata, tags }) => {
          expectTypeOf(metadata).toEqualTypeOf<MetadataContext>();
          expectTypeOf(tags).toEqualTypeOf<TagsContext>();
          expectTypeOf(await metadata.set({ phase: 'copying' })).toEqualTypeOf<
            { readonly metadata: RunMetadata } | Refusal
          >();
          expectTypeOf(await tags.add('a', 'b')).toEqualTypeOf<{ readonly tags: readonly string[] } | Refusal>();
          return 'done';
        },
        {
          undo: ({ metadata, tags }) => {
            expectTypeOf(metadata).toEqualTypeOf<MetadataContext>();
            expectTypeOf(tags).toEqualTypeOf<TagsContext>();
          },
        },
      )
      .finish();
  });

  it('a patch is a JSON object, a key a string, `by` an optional number, and tags strings', () => {
    expectTypeOf<Parameters<MetadataContext['set']>>().toEqualTypeOf<[patch: RunMetadata]>();
    expectTypeOf<Parameters<MetadataContext['increment']>>().toEqualTypeOf<[key: string, by?: number]>();
    expectTypeOf<Parameters<MetadataContext['append']>>().toEqualTypeOf<[key: string, value: unknown]>();
    expectTypeOf<Parameters<MetadataContext['remove']>>().toEqualTypeOf<[key: string]>();
    expectTypeOf<Parameters<TagsContext['add']>>().toEqualTypeOf<string[]>();
    // A list is not a patch: the metadata is an object.
    expectTypeOf<string[]>().not.toExtend<RunMetadata>();
  });
});
