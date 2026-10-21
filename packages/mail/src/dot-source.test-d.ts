import { expectTypeOf } from 'vitest';

import type { UnitSourceGuard } from '@arki/dot/unit';

import type { mail, mailOutboxPlugin } from './dot.js';

// Adapters must retain their authored callbacks so apps can mount them without erasing lifecycle returns.
expectTypeOf<UnitSourceGuard<ReturnType<typeof mail>>>().toEqualTypeOf<[]>();
expectTypeOf<UnitSourceGuard<ReturnType<typeof mailOutboxPlugin>>>().toEqualTypeOf<[]>();
