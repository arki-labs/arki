import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Journal } from './api.js';
import { initJournal } from './journal.js';
import { tables } from './test-support.js';
import type { openJournalDb } from './testing.js';
import { workflowHarness } from './testing.js';

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

  it('refuses a setup that returns a name the harness gives', async () => {
    // @ts-expect-error -- `drain` is the harness's own member, so setup may not return it.
    await workflowHarness({ setup: clash });
    // @ts-expect-error -- so is `db`.
    await workflowHarness({ setup: () => ({ ...setup(), db: 1 }) });
  });
});
