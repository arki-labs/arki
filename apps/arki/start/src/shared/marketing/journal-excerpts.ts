/**
 * The journal chapter's code and quotes (sheets J-100 to J-104), on `/` floor F4 and on `/packages/journal`. Kept apart
 * from the build path's excerpts so the package page downloads only these.
 */
import type { Excerpt, SourceQuote } from './excerpt';

const README_FILE = 'packages/journal/README.md';
const WRITE_FILE = 'packages/journal/src/write.ts';
const COMMAND_FILE = 'packages/journal/src/command.ts';

/** The chapter's headline: the homepage floor's title, and the lead on the package page. */
export const JOURNAL_HEADLINE = 'Crash it. Retry it. Nothing pays twice, nothing gets lost.';

/** J-100: the order entity. Each reducer says what one event does to the row; a stepper lights the one that ran. */
export const ORDER_ENTITY = {
  parts: [
    {
      id: 'imports',
      path: README_FILE,
      from: 46,
      imports: true,
      lines: ["import { CommandConflict, CommandNotFound, initJournal, need } from '@arki/journal';"],
    },
    {
      id: 'journal',
      path: README_FILE,
      from: 52,
      lines: ['export const j = initJournal({ tables, meta: z.object({ actorId: z.string() }) });'],
    },
    {
      id: 'events',
      path: README_FILE,
      from: 69,
      lines: [
        "export const OrderPlaced = j.event('OrderPlaced', z.object({ customerId: z.string(), total: z.int().positive() }));",
        "export const OrderPaid = j.event('OrderPaid', z.object({ amount: z.int().positive() }));",
        "export const OrderCancelled = j.event('OrderCancelled', z.object({ reason: z.string().min(1) }));",
      ],
    },
    {
      id: 'entity',
      path: README_FILE,
      from: 73,
      lines: ['export const order = j', "  .entity('order', orders)"],
    },
    {
      id: 'create',
      path: README_FILE,
      from: 75,
      lines: [
        "  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))",
      ],
    },
    {
      id: 'paid',
      path: README_FILE,
      from: 76,
      lines: ["  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change"],
    },
    {
      id: 'cancelled',
      path: README_FILE,
      from: 77,
      lines: ['  .on(OrderCancelled, () => null); // null deletes the row; the events stay'],
    },
  ],
} as const satisfies Excerpt;

/** J-101: the command, and the effect that sends the email once the write has committed. */
export const PAY_ORDER = {
  parts: [
    {
      id: 'imports',
      path: README_FILE,
      from: 46,
      imports: true,
      lines: ["import { CommandConflict, CommandNotFound, initJournal, need } from '@arki/journal';"],
    },
    {
      id: 'command',
      path: README_FILE,
      from: 81,
      lines: [
        'export const payOrder = j.command(',
        "  'payOrder',",
        '  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),',
        '  (input, { write }) =>',
        '    write(order, input.orderId, row => {',
        "      if (!row) return CommandNotFound({ detail: 'Order not found' });",
        "      if (row.status !== 'placed') return CommandConflict({ detail: `Order is already ${row.status}` });",
        '      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing',
        '    }),',
        ');',
      ],
    },
    {
      id: 'effect',
      path: README_FILE,
      from: 106,
      lines: [
        'export const orderMail = j.effect(',
        "  'order-mail',",
        '  order,',
        '  { mailer: need<Mailer>() },',
        '  {',
      ],
    },
    {
      id: 'send',
      path: README_FILE,
      from: 111,
      lines: [
        '    OrderPaid: (e, { jobId, mailer }) =>',
        "      mailer.send({ template: 'order-paid', orderId: e.entityId, idempotencyKey: jobId }),",
      ],
    },
    {
      id: 'effect-end',
      path: README_FILE,
      from: 113,
      lines: ['  },', ');'],
    },
  ],
} as const satisfies Excerpt;

/** J-101: the order of the four writes inside one transaction. The stepper lights the write it is on. */
export const WRITE_ORDER = {
  note: 'the four writes, in order',
  parts: [
    {
      id: 'imports',
      path: WRITE_FILE,
      from: 18,
      imports: true,
      lines: ["import type { JournalTables } from './pg.js';"],
    },
    {
      id: 'tables',
      path: WRITE_FILE,
      from: 115,
      lines: ['  const { events: eventsTable, jobs: jobsTable } = deps.tables;'],
    },
    {
      id: 'event',
      path: WRITE_FILE,
      from: 271,
      lines: ['        const inserted = await sp', '          .insert(eventsTable)', '          .values(eventRows)'],
    },
    {
      id: 'row',
      path: WRITE_FILE,
      from: 350,
      lines: [
        '          const updated = await sp',
        '            .update(erased)',
        '            .set({ ...next, version: finalVersion })',
        '            .where(atBase)',
      ],
    },
    {
      id: 'projection',
      path: WRITE_FILE,
      from: 377,
      lines: [
        '        for (const event of recorded) {',
        '          for (const projection of projections) {',
        '            if (projection.types.has(event.type) && projection.entities.some(e => e.kind === entity.kind)) {',
        '              await projection.run(sp, event);',
      ],
    },
    {
      id: 'job',
      path: WRITE_FILE,
      from: 405,
      lines: ['        if (jobs.length > 0) await sp.insert(jobsTable).values(jobs);'],
    },
  ],
} as const satisfies Excerpt;

/** J-102: the first run claims the receipt; a repeat with another input is refused. */
export const CLAIM_RECEIPT = {
  parts: [
    {
      id: 'import-errors',
      path: COMMAND_FILE,
      from: 24,
      imports: true,
      lines: ["import { CommandConflict, JournalError } from './errors.js';"],
    },
    {
      id: 'import-storage',
      path: COMMAND_FILE,
      from: 28,
      imports: true,
      lines: ["import { assertRoundTrips, sameValue } from './storage.js';"],
    },
    {
      id: 'claim',
      path: COMMAND_FILE,
      from: 76,
      lines: [
        '    const inserted = await tx',
        '      .insert(receipts)',
        '      .values({ key, command: name, input: throughJson(input) ?? null, commandId: own })',
        '      .onConflictDoNothing()',
        '      .returning({ key: receipts.key });',
        '    if (inserted.length > 0) return undefined;',
      ],
    },
    {
      id: 'conflict',
      path: COMMAND_FILE,
      from: 90,
      lines: [
        '    if (held.command !== name)',
        '      return CommandConflict({ detail: `the idempotency key is held by command "${held.command}", not "${name}"` });',
        '    if (!sameValue(held.input, throughJson(input) ?? null))',
        '      return CommandConflict({ detail: `the idempotency key was used by command "${name}" with a different input` });',
      ],
    },
  ],
} as const satisfies Excerpt;

/** J-103: the reducers that `verify` and `repair` fold over the events. */
export const ORDER_REDUCERS = {
  parts: [
    {
      id: 'imports',
      path: README_FILE,
      from: 46,
      imports: true,
      lines: ["import { CommandConflict, CommandNotFound, initJournal, need } from '@arki/journal';"],
    },
    {
      id: 'entity',
      path: README_FILE,
      from: 73,
      lines: [
        'export const order = j',
        "  .entity('order', orders)",
        "  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))",
        "  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change",
        '  .on(OrderCancelled, () => null); // null deletes the row; the events stay',
      ],
    },
  ],
} as const satisfies Excerpt;

/** J-104: the refund workflow from the README. A stepper lights the node the run is on. */
export const REFUND_STEPS = {
  parts: [
    {
      id: 'imports',
      path: README_FILE,
      from: 821,
      imports: true,
      lines: ["import { z } from 'zod';"],
    },
    {
      id: 'hold',
      path: README_FILE,
      from: 848,
      lines: ["  .step('hold', ({ input, payments }) => payments.hold(input.paymentId, input.amount), {"],
    },
    {
      id: 'undo',
      path: README_FILE,
      from: 849,
      lines: ['    undo: ({ result, payments }) => payments.release(result.holdId),'],
    },
    {
      id: 'hold-end',
      path: README_FILE,
      from: 850,
      lines: [
        '  })',
        '  // `key` is the same on every try of this step: the provider dedupes on it. `output` checks the stored result, so',
        '  // `def.read` types it and an operator can supply it by hand (`resolveStep`).',
      ],
    },
    {
      id: 'payBack',
      path: README_FILE,
      from: 853,
      lines: [
        "  .step('payBack', ({ input, key, payments }) => payments.refund(input.paymentId, input.amount, key), {",
        '    output: z.object({ refundId: z.string() }),',
        '  })',
      ],
    },
    {
      id: 'wait',
      path: README_FILE,
      from: 856,
      lines: [
        "  // The run parks here until the provider's webhook sends the signal.",
        "  .waitFor('settled', { signal: 'provider.refund.settled', schema: Settled, timeout: '3d' })",
      ],
    },
  ],
} as const satisfies Excerpt;

/** J-103: the verbs, in the README's own words. */
export const JOURNAL_VERBS = [
  {
    path: README_FILE,
    line: 366,
    text: 'Other verbs: `replay(db, entity, id, { throughVersion })` (returns the reducer-shaped row), `verify(db, entity, id)`, `repair(db, entity, id)`',
  },
  {
    path: README_FILE,
    line: 262,
    text: '`journal.forget(db, entity, id)` rewrites every stored event of that entity that has an erased form to it, sets `erased_at` on those rows, and then repairs the row from the rewritten log, so the row and its history agree. All in one transaction.',
  },
  {
    path: README_FILE,
    line: 260,
    text: "An event that can hold personal data declares its erased form: `j.event('MessageSent', schema, { erased: data => ({ ...data, content: '' }) })`.",
  },
] as const satisfies readonly SourceQuote[];

/** The tests that prove each journal sheet, by the name they are written under. */
export const JOURNAL_PROOFS = {
  throwingProjection: {
    path: 'packages/journal/src/journal.test.ts',
    line: 239,
    text: 'a throwing projection rolls back events, row and jobs',
  },
  crashAfterSend: {
    path: 'packages/journal/src/jobs.pg.test.ts',
    line: 166,
    text: 'a crash after the external effect, before the ack, repeats the job under the same id',
  },
  receiptReplay: {
    path: 'packages/journal/src/command.test.ts',
    line: 593,
    text: 'a repeat with the same key and input returns the first result without running the handler again',
  },
  verifyRepair: {
    path: 'packages/journal/src/journal.test.ts',
    line: 577,
    text: 'verify reports a drifted row and repair fixes it from the log',
  },
  forget: {
    path: 'packages/journal/src/journal.test.ts',
    line: 682,
    text: 'forget rewrites the events that have an erased form, stamps them, and repairs the row to match',
  },
  stepRerun: {
    path: 'packages/journal/src/workflow/runner.test.ts',
    line: 459,
    text: 'crash after external success before checkpoint re-runs the step with the same key, and the committed checkpoint never runs it again',
  },
  deadStepWaits: {
    path: 'packages/journal/src/workflow/compensation.test.ts',
    line: 399,
    text: 'a dead step waits for an operator by default and compensates with onDeadStep',
  },
  cancelUndoes: {
    path: 'packages/journal/src/workflow/compensation.test.ts',
    line: 311,
    text: 'cancel on a parked run undoes completed steps in reverse and ends cancelled',
  },
  signalWins: {
    path: 'packages/journal/src/workflow/wait.pg.test.ts',
    line: 155,
    text: 'a signal that commits while the timeout is in flight wins, and the timeout commits nothing',
  },
} as const satisfies Record<string, SourceQuote>;
