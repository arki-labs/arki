import { expectTypeOf } from 'vitest';
import type { z } from 'zod';

import type { MailMessage } from '../types.js';
import type { QueuedArgs } from './args.js';
import type { mailMessageSchema, queuedArgsSchema } from './args-schemas.js';

/** `MailMessage` is an intersection; flattening it lets the type test compare field by field. */
type Flat<T> = { [K in keyof T]: T[K] };

// The stored shape must stay the message type: a field added to one and not the other is a type error here.
expectTypeOf<Flat<z.output<typeof mailMessageSchema>>>().toEqualTypeOf<Flat<MailMessage>>();

// The row shape must stay `QueuedArgs`, the type `./pg` names. `message` is compared flat, like above.
type QueuedOutput = z.output<typeof queuedArgsSchema>;
expectTypeOf<Omit<QueuedOutput, 'message'>>().toEqualTypeOf<Omit<QueuedArgs, 'message'>>();
expectTypeOf<Flat<QueuedOutput['message']>>().toEqualTypeOf<Flat<QueuedArgs['message']>>();
