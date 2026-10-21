import { describe, expectTypeOf, it } from 'vitest';

import type { PackageEntry } from '@arki/arki-release/site-schema';
import type { z } from '@arki/contracts';

import type { packageMirrorListSchema } from './package-docs.build';

describe('packageMirrorListSchema', () => {
  it('reads exactly the `short` and `mirror` of a `PackageEntry`', () => {
    // The config cannot import the source schema, so this test is what keeps the two from drifting.
    expectTypeOf<z.output<typeof packageMirrorListSchema>>().toEqualTypeOf<Pick<PackageEntry, 'short' | 'mirror'>[]>();
  });
});
