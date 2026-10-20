import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';

/** Opaque external keys remain valid; newly generated keys retain UUID v4 bytes. */
export const queueJobId = defineId('', { kind: 'queue.job', format: 'uuid' });
export type QueueJobId = IdOf<typeof queueJobId>;
