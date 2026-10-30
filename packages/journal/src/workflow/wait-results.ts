/**
 * An event wait stores a pointer to the event it took (`waitPointerSchema`), never the event. This turns the pointers of
 * a run's results back into what a body reads: the label and the log row as it is now, so an event `forget` erased reads
 * in its erased form, whether the run is parked, running or finished.
 */
import { inArray } from 'drizzle-orm';

import { ensure, is } from '@arki/schema';

import type { JournalTables } from '../pg.js';
import type { DbHandle } from '../types.js';
import { JournalError } from '../errors.js';
import { storedWaitResultSchema, waitPointerSchema } from './run-field-schemas.js';

/** The results of a run with each event wait's pointer replaced by the event read from the log. Other results are as they were. */
export async function withWaitEvents(
  db: DbHandle,
  tables: Pick<JournalTables, 'events'>,
  runId: string,
  nodes: readonly { readonly name: string; readonly kind: string }[],
  results: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const pointers = nodes
    .filter(node => node.kind === 'eventWait' && is(results[node.name], waitPointerSchema))
    .map(node => ({ name: node.name, pointer: ensure(results[node.name], waitPointerSchema) }));
  if (pointers.length === 0) return results;
  const rows = await db
    .select()
    .from(tables.events)
    .where(inArray(tables.events.seq, [...new Set(pointers.map(({ pointer }) => pointer.seq))]));
  const live = { ...results };
  for (const { name, pointer } of pointers) {
    const event = rows.find(row => row.seq === pointer.seq);
    if (event === undefined) {
      throw new JournalError(
        'HISTORY_GAP',
        'workflow',
        runId,
        `the event wait '${name}' took the event with seq ${pointer.seq}, and the log has no such event`,
      );
    }
    live[name] = storedWaitResultSchema.encode({ via: pointer.via, event });
  }
  return live;
}
