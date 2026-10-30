import { expectTypeOf } from 'vitest';
import type { z } from 'zod';

import type { MailMessage } from '../types.js';
import type { mailMessageSchema } from './args.js';

/** `MailMessage` is an intersection; flattening it lets the type test compare field by field. */
type Flat<T> = { [K in keyof T]: T[K] };

// The stored shape must stay the message type: a field added to one and not the other is a type error here.
expectTypeOf<Flat<z.output<typeof mailMessageSchema>>>().toEqualTypeOf<Flat<MailMessage>>();
