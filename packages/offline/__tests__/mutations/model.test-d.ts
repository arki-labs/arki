import { expectTypeOf, it } from 'vitest';
import type { z } from '@arki/contracts';

import type { DeadLetterEntry } from '../../src/mutations/dead-letter.ts';
import type { EnqueueReceipt, QueuedMutation } from '../../src/mutations/model.ts';
import type { deadLetterEntrySchema, enqueueReceiptSchema, queuedMutationSchema } from '../../src/mutations/model-schemas.ts';

// The queue's TS types are the source and its public `.d.ts` names no Zod type. The schemas that check stored
// values must stay equal to them: a field added to one side only, a widened enum or a dropped `optional` fails here.
it('every stored-value schema parses to exactly its type', () => {
  expectTypeOf<z.output<typeof queuedMutationSchema>>().toEqualTypeOf<QueuedMutation>();
  expectTypeOf<z.output<typeof enqueueReceiptSchema>>().toEqualTypeOf<EnqueueReceipt>();
  expectTypeOf<z.output<typeof deadLetterEntrySchema>>().toEqualTypeOf<DeadLetterEntry>();
});
