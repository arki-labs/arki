import { expectTypeOf } from 'vitest';

import type { Deferred } from '../plugin.js';
import { resolveDeferred } from '../plugin.js';

// Deferred: a value or a function that makes it. resolveDeferred gives back the value.
expectTypeOf<Deferred<number>>().toEqualTypeOf<number | (() => number)>();
expectTypeOf(resolveDeferred<number>(() => 1)).toEqualTypeOf<number>();
