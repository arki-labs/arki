/**
 * The public types (`types.ts`) are plain TypeScript; the runtime checks
 * (`schema.ts`) are internal Zod. This test is what keeps them one shape:
 * each schema must parse to exactly its public type, so changing one without
 * the other fails `typecheck`.
 */
import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { LiveCursor, LiveEvent, LiveManifest, LiveMeta, LiveScopes, TableTag } from '../index.js';
import type {
  liveCursorSchema,
  liveEventSchema,
  liveManifestSchema,
  liveMetaSchema,
  liveScopesSchema,
  tableTagSchema,
} from '../schema.js';

describe('public types match their internal schemas', () => {
  it('each schema parses to exactly its type', () => {
    expectTypeOf<z.output<typeof tableTagSchema>>().toEqualTypeOf<TableTag>();
    expectTypeOf<z.output<typeof liveMetaSchema>>().toEqualTypeOf<LiveMeta>();
    expectTypeOf<z.output<typeof liveManifestSchema>>().toEqualTypeOf<LiveManifest>();
    expectTypeOf<z.output<typeof liveCursorSchema>>().toEqualTypeOf<LiveCursor>();
    expectTypeOf<z.output<typeof liveEventSchema>>().toEqualTypeOf<LiveEvent>();
    // The declaration is server config with readonly arrays: what the schema parses must fit it.
    expectTypeOf<z.output<typeof liveScopesSchema>>().toExtend<LiveScopes>();
  });
});
