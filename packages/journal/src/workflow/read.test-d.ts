import { describe, expectTypeOf, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { DbHandle } from '../types.js';
import type { RunDetail, RunState, RunSummary, StepView, StrandedReason } from './read.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const journal = j.compose({});
declare const db: DbHandle;

describe('journal.workflows, as types', () => {
  it('a page of runs has a cursor and runs with the derived stuck and stranded', async () => {
    const page = await journal.workflows.runs(db, { state: 'parked', stuck: true, limit: 5, after: 'x' });
    expectTypeOf(page.runs).toEqualTypeOf<RunSummary[]>();
    expectTypeOf(page.next).toEqualTypeOf<string | null>();
    expectTypeOf(page.runs[0]?.stuck).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(page.runs[0]?.stranded).toEqualTypeOf<StrandedReason | null | undefined>();
    // @ts-expect-error a state the run table does not have
    await journal.workflows.runs(db, { state: 'stuck' });
  });

  it('a step shows running and stuck next to what the row stores', () => {
    expectTypeOf<StepView['status']>().toEqualTypeOf<'scheduled' | 'done' | 'skipped' | 'failed' | 'running'>();
    expectTypeOf<RunDetail['residual']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<RunState>().toEqualTypeOf<
      'running' | 'parked' | 'compensating' | 'completed' | 'failed' | 'cancelled'
    >();
  });

  it('the verbs take the T13 operator and say how they moved the run', async () => {
    const done = await journal.workflows.retryStep(db, { runId: 'r', path: 'p', phase: 'do' }, { actor: 'usr' });
    expectTypeOf(orThrow(done).how).toEqualTypeOf<'rescheduled' | 'childrenRestarted' | 'jobRetried'>();
    // @ts-expect-error every operation names who did it
    orThrow(await journal.workflows.skipUndo(db, { runId: 'r', path: 'p' }, {}));
  });
});
