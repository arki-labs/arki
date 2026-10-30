/**
 * The fixture app of the event-map tests: orders and payments. It is a small Dot app laid out as a real one is
 * (`features/<name>/{model,usecases,entrypoints}`), so the scan, the graph and the Mermaid file are proved on one
 * app that has every kind of edge. Excluded from the build.
 */
import { z } from 'zod';

import { initJournal } from '../../../../journal.js';
import { journalTables } from '../../../../pg.js';

export const tables = journalTables();
export const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

/** A handler that does nothing: the fixture declares the edge, and nothing runs. */
export function ignore(..._ignored: readonly unknown[]): void {
  // Nothing to do.
}
