import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import type { Journal } from './api.js';
import { initJournal } from './journal.js';
import { tables } from './test-support.js';
import { openJournalDb, workflowHarness, workflowHarnessOn } from './testing.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const meta = z.object({ actorId: z.string() });
const workflowMeta = { actorId: 'system' };
const setup = () => {
  const j = initJournal({ tables, meta });
  const nap = j.workflow('nap', { version: 1, input: z.object({}) }).sleep('wait', '1h').finish();
  return { tables, journal: j.compose({ workflows: [nap], workflowMeta }), nap };
};
type Setup = ReturnType<typeof setup>;
/** A setup that also returns `drain`, a name the harness gives. */
const clash = () => ({ ...setup(), drain: 'mine' });

describe('workflowHarness', () => {
  it('shows what setup returned, typed as setup returned it, next to its own members', async () => {
    const h = await workflowHarness({ setup });
    expectTypeOf(h.journal).toEqualTypeOf<Setup['journal']>();
    expectTypeOf(h.journal).toExtend<Journal<typeof meta>>();
    expectTypeOf(h.nap).toEqualTypeOf<Setup['nap']>();
    expectTypeOf(h.db).toEqualTypeOf<Awaited<ReturnType<typeof openJournalDb>>['db']>();
    expectTypeOf(h.crash).toEqualTypeOf<() => void>();
  });

  it('release picks from what dueJobs gives, and gives the job back', async () => {
    const h = await workflowHarness({ setup });
    const due = await h.dueJobs();
    expectTypeOf(due[0]?.effect).toEqualTypeOf<string | null | undefined>();
    const released = await h.release(job => job.runId === 'r');
    expectTypeOf(released).toExtend<(typeof due)[number] | { readonly code: string }>();
    // @ts-expect-error -- a pick says yes or no.
    orThrow(await h.release(() => 'yes'));
  });

  it('workflowHarnessOn keeps the database it is given, typed', async () => {
    const { db } = await openJournalDb(tables);
    const h = workflowHarnessOn(db, { setup });
    expectTypeOf(h.db).toEqualTypeOf<typeof db>();
    expectTypeOf(h.nap).toEqualTypeOf<Setup['nap']>();
    // @ts-expect-error -- `drain` is the harness's own member here too.
    workflowHarnessOn(db, { setup: clash });
  });

  it('refuses a setup that returns a name the harness gives', async () => {
    // @ts-expect-error -- `drain` is the harness's own member, so setup may not return it.
    await workflowHarness({ setup: clash });
    // @ts-expect-error -- so is `db`.
    await workflowHarness({ setup: () => ({ ...setup(), db: 1 }) });
  });
});
