import { expectTypeOf } from 'vitest';

import type { PluginSourceGuard } from '@arki/dot/plugin';

import type { mail, mailOutboxPlugin } from './dot.js';

// Adapters must retain their authored callbacks so apps can mount them without erasing lifecycle returns.
expectTypeOf<PluginSourceGuard<ReturnType<typeof mail>>>().toEqualTypeOf<[]>();
expectTypeOf<PluginSourceGuard<ReturnType<typeof mailOutboxPlugin>>>().toEqualTypeOf<[]>();
