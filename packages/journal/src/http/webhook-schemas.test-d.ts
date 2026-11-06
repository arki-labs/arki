import type { z } from 'zod';
import { expectTypeOf } from 'vitest';

import type { dispatchInput, subscribeInput } from './webhook-schemas.js';
import type { DispatchInput, SubscribeInput } from './webhooks.js';

// The input types are the source and `./http/webhooks` names no Zod type. The schemas that parse the input must
// accept exactly them: a field added to one side only or a dropped `readonly` is a type error here.
expectTypeOf<z.input<typeof subscribeInput>>().toEqualTypeOf<SubscribeInput>();
expectTypeOf<z.input<typeof dispatchInput>>().toEqualTypeOf<DispatchInput>();
