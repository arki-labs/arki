/**
 * Compile-time only (checked by `tsc`): the consumer schema has exactly the
 * fields `arki-doc-examples --json` prints, so a field the producer adds or
 * renames fails here instead of in a ship run.
 */
import { expectTypeOf } from 'vitest';

import type { ExamplesReport } from '@arki/library-tooling/src/doc-examples';

import type { DocExamplesReport } from './doc-examples-report-schema';

expectTypeOf<keyof ExamplesReport>().toEqualTypeOf<keyof DocExamplesReport>();
