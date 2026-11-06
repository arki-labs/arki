import { get, set } from 'idb-keyval';
import type { z } from '@arki/contracts';

import { QueueStorageCorrupt, QueueStorageUnavailable, QueuePersistenceUnconfirmed, QueueEncodingFailure } from './failures.js';
import type { QueueStorageFailure } from './failures.js';
import { observeQueue } from './telemetry.js';
import { offlineSerializer } from '../serializer.js';

// Internal: the storage and the dead-letter store read and write through these. They live apart from
// `storage.ts` so `./mutations` names no Zod type (`TYPES_E001`).

/** Persistence decode boundary shared by the queue and dead-letter store. */
export async function readOfflineState<Schema extends z.ZodType>(storageKey: string, schema: Schema, empty: z.output<Schema>): Promise<z.output<Schema> | QueueStorageFailure> {
  return observeQueue('offline.storage.read', async () => {
    let raw: unknown;
    try { raw = await get<unknown>(storageKey); }
    catch (error) { return QueueStorageUnavailable({ cause: error }); }
    if (raw === undefined) return empty;
    try {
      if (typeof raw !== 'string') return QueueStorageCorrupt();
      const parsed: unknown = offlineSerializer.parse(raw);
      const result = schema.safeParse(parsed);
      return result.success ? result.data : QueueStorageCorrupt({ cause: result.error });
    } catch (error) { return QueueStorageCorrupt({ cause: error }); }
  });
}

export async function writeOfflineState(storageKey: string, value: unknown, schema: z.ZodType): Promise<void | QueueStorageFailure> {
  return observeQueue('offline.storage.write', async () => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return QueueEncodingFailure({ cause: parsed.error });
    let encoded: string;
    try { encoded = offlineSerializer.stringify(parsed.data); }
    catch (error) { return QueueEncodingFailure({ cause: error }); }
    try { await set(storageKey, encoded); }
    catch (error) { return QueuePersistenceUnconfirmed({ cause: error }); }
    return;
  });
}
