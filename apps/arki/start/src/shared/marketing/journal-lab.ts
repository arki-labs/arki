/**
 * The five benches of the journal chapter, as plain reducers. It is a browser simulation: nothing here talks to a
 * database. Every table, column, event, command and signal name is a real one from `packages/journal` (README.md and
 * `src/workflow/machine.ts`); `e2e/home.spec.ts` checks the workflow event names against the engine.
 *
 * Each bench starts from a finished run, so the server render (and a reader without JavaScript) shows a meaningful
 * state. The first client render must match it, so the start states are constants, not random.
 */

/** The latest `@arki/journal` on npm. J-104 is newer than it. `e2e/home.spec.ts` checks it against packages.json. */
export const JOURNAL_NPM_VERSION = '0.2.1';

// ── J-100 · the row is a replay ──────────────────────────────────────────────────────────────────────────────

/** The order entity's events (README.md:69–71), with the data this simulation appends. */
export const ORDER_EVENTS = {
  OrderPlaced: "{ customerId: 'cus_12', total: 4800 }",
  OrderPaid: '{ amount: 4800 }',
  OrderCancelled: "{ reason: 'customer asked' }",
} as const;
export type OrderEvent = keyof typeof ORDER_EVENTS;

/** The `orders` columns the chapter shows (README.md:60–65), in table order. */
export const ORDER_COLUMNS = ['customer_id', 'total', 'status', 'version'] as const;
export type OrderColumn = (typeof ORDER_COLUMNS)[number];
export type OrderRow = Readonly<Record<OrderColumn, string>>;

/** The id of the one order every bench uses. */
export const ORDER_ID = 'ord_7f3';

/** One reducer of README.md:75–77: what `event` does to the row. Null: no row (not created yet, or deleted). */
function reduceOrder(row: OrderRow | null, event: OrderEvent, version: string): OrderRow | null {
  if (event === 'OrderPlaced') return { customer_id: 'cus_12', total: '4800', status: 'placed', version };
  if (event === 'OrderPaid') return row === null ? null : { ...row, status: 'paid', version };
  return null;
}

/** The row the first `through` events build, folded from nothing, as `replay` does. */
export function foldOrder(events: readonly OrderEvent[], through = events.length): OrderRow | null {
  return events
    .slice(0, through)
    .reduce<OrderRow | null>((row, event, index) => reduceOrder(row, event, String(index + 1)), null);
}

export type ReplayState = {
  events: readonly OrderEvent[];
  /** The version the replay pane folds through; null follows the newest. */
  through: number | null;
};

export type ReplayAction =
  { type: 'append'; event: OrderEvent } | { type: 'through'; version: number } | { type: 'reset' };

/** Placed, paid, and the replay pane rewound to version 1: the live row and an older one side by side. */
export const REPLAY_START: ReplayState = { events: ['OrderPlaced', 'OrderPaid'], through: 1 };

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  if (action.type === 'append') return { events: [...state.events, action.event], through: null };
  if (action.type === 'through') return { ...state, through: action.version };
  return { events: [], through: null };
}

/** The events that make sense next: create once, pay a placed order, cancel a live one. */
export function appendable(events: readonly OrderEvent[]): readonly OrderEvent[] {
  const live = foldOrder(events);
  if (events.length === 0) return ['OrderPlaced'];
  return live === null ? [] : live.status === 'placed' ? ['OrderPaid', 'OrderCancelled'] : ['OrderCancelled'];
}

/** The columns the newest event changed in the live row. */
export function changedColumns(events: readonly OrderEvent[]): ReadonlySet<OrderColumn> {
  const before = foldOrder(events, events.length - 1);
  const after = foldOrder(events);
  if (after === null) return new Set();
  return new Set(ORDER_COLUMNS.filter(column => before?.[column] !== after[column]));
}

// ── J-101 · pull the plug ────────────────────────────────────────────────────────────────────────────────────

/** The four writes inside one transaction, in the order `write.ts` makes them (lines 272, 350, 378, 405). */
export const WRITE_STEPS = ['event', 'row', 'projection', 'job'] as const;
export const PLUG_PHASES = ['idle', 'writing', 'cut', 'committed'] as const;
/** What the worker did with the job: nothing yet, sent and acked, died after the send, ran it again. */
export const WORKER_STATES = ['idle', 'sent', 'killed', 'reran'] as const;
export const PLUG_ACTIONS = ['run', 'tick', 'plug', 'send', 'kill', 'rerun', 'reset'] as const;

export type PlugAction = (typeof PLUG_ACTIONS)[number];
export type PlugState = {
  phase: (typeof PLUG_PHASES)[number];
  /** How many of the four writes happened before the commit, or before the cut. */
  written: number;
  worker: (typeof WORKER_STATES)[number];
};

/** Committed, the email sent, the worker killed before its ack and the job run again: the whole story, finished. */
export const PLUG_START: PlugState = { phase: 'committed', written: WRITE_STEPS.length, worker: 'reran' };
const PLUG_IDLE: PlugState = { phase: 'idle', written: 0, worker: 'idle' };

export function plugReducer(state: PlugState, action: PlugAction): PlugState {
  switch (action) {
    case 'run': {
      return { ...PLUG_IDLE, phase: 'writing', written: 1 };
    }
    case 'tick': {
      if (state.phase !== 'writing') return state;
      return state.written < WRITE_STEPS.length
        ? { ...state, written: state.written + 1 }
        : { ...state, phase: 'committed' };
    }
    case 'plug': {
      return state.phase === 'writing' ? { ...state, phase: 'cut' } : state;
    }
    case 'send': {
      return { ...state, worker: 'sent' };
    }
    case 'kill': {
      return { ...state, worker: 'killed' };
    }
    case 'rerun': {
      return { ...state, worker: 'reran' };
    }
    case 'reset': {
      return PLUG_IDLE;
    }
  }
}

/** Attempts on the job row and emails in the inbox, for each worker state. */
export const WORKER_COUNTS = {
  idle: { attempts: 0, emails: 0 },
  sent: { attempts: 1, emails: 1 },
  killed: { attempts: 1, emails: 1 },
  reran: { attempts: 2, emails: 1 },
} as const satisfies Record<PlugState['worker'], { attempts: number; emails: number }>;

// ── J-102 · the webhook arrives three times ─────────────────────────────────────────────────────────────────

export type WebhookState = {
  deliveries: number;
  /** The last delivery reused the key with another body. */
  conflict: boolean;
};
export const WEBHOOK_ACTIONS = ['deliver', 'different', 'reset'] as const;
export type WebhookAction = (typeof WEBHOOK_ACTIONS)[number];

/** Three deliveries of the same event: the state the sheet promises. */
export const WEBHOOK_START: WebhookState = { deliveries: 3, conflict: false };

export function webhookReducer(state: WebhookState, action: WebhookAction): WebhookState {
  if (action === 'deliver') return { deliveries: state.deliveries + 1, conflict: false };
  if (action === 'different') return { deliveries: Math.max(state.deliveries, 1), conflict: true };
  return { deliveries: 0, conflict: false };
}

/** How many times the command body ran: once, whatever the delivery count. */
export const handlerRuns = (state: WebhookState): number => Math.min(state.deliveries, 1);

// ── J-103 · verify, repair, forget ──────────────────────────────────────────────────────────────────────────

/** The two hand edits the bench offers: a plain UPDATE that no event explains. */
export const HAND_EDITS = { status: 'shipped', total: '1' } as const;
export type HandEdit = keyof typeof HAND_EDITS;
export const VERIFY_RESULTS = ['unchecked', 'drift', 'ok'] as const;

export type RepairState = {
  edits: Readonly<Record<HandEdit, boolean>>;
  verified: (typeof VERIFY_RESULTS)[number];
  /** `journal.forget` ran: the OrderPlaced event holds its erased form. */
  forgotten: boolean;
};
export type RepairAction = { type: 'edit'; column: HandEdit } | { type: 'verify' | 'repair' | 'forget' | 'reset' };

/** Someone set status by hand, and verify caught it. */
export const REPAIR_START: RepairState = { edits: { status: true, total: false }, verified: 'drift', forgotten: false };

/** The row the events rebuild: what `verify` expects. */
export function expectedRow(state: RepairState): OrderRow {
  return { customer_id: state.forgotten ? "''" : 'cus_12', total: '4800', status: 'paid', version: '2' };
}

/** The row in the table: the expected one with the hand edits on top. */
export function actualRow(state: RepairState): OrderRow {
  const row = expectedRow(state);
  return {
    ...row,
    status: state.edits.status ? HAND_EDITS.status : row.status,
    total: state.edits.total ? HAND_EDITS.total : row.total,
  };
}

/** The columns where the table and its history disagree. */
export function drift(state: RepairState): readonly OrderColumn[] {
  const want = expectedRow(state);
  const have = actualRow(state);
  return ORDER_COLUMNS.filter(column => want[column] !== have[column]);
}

const CLEAN = { status: false, total: false } as const;

export function repairReducer(state: RepairState, action: RepairAction): RepairState {
  switch (action.type) {
    case 'edit': {
      return {
        ...state,
        edits: { ...state.edits, [action.column]: !state.edits[action.column] },
        verified: 'unchecked',
      };
    }
    case 'verify': {
      return { ...state, verified: drift(state).length > 0 ? 'drift' : 'ok' };
    }
    case 'repair': {
      return { ...state, edits: CLEAN, verified: 'ok' };
    }
    case 'forget': {
      return { edits: CLEAN, verified: 'ok', forgotten: true };
    }
    case 'reset': {
      return { edits: CLEAN, verified: 'unchecked', forgotten: false };
    }
  }
}

// ── J-104 · the refund workflow (next) ──────────────────────────────────────────────────────────────────────

/** The workflow events this bench writes. Each is a real event of the `workflow.run` entity. */
export const WORKFLOW_EVENTS = [
  'RunStarted',
  'NodeScheduled',
  'NodeCompleted',
  'NodeFailed',
  'Parked',
  'SignalReceived',
  'TimerFired',
  'CancelRequested',
  'CompensationStarted',
  'RunCompleted',
  'RunCancelled',
] as const;
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

/** One row in the run's history. A row with no `type` is not an event: the server restarted and wrote nothing. */
export type RunRow = { readonly type: WorkflowEvent | null; readonly node: string; readonly note: string };

export const RUN_PHASES = ['idle', 'hold', 'payBack', 'parked', 'stuck', 'completed', 'cancelled'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const RUN_ACTIONS = ['start', 'tick', 'restart', 'signal', 'wait', 'race', 'cancel', 'reset'] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export type RunState = {
  phase: RunPhase;
  rows: readonly RunRow[];
  /** Calls the provider saw, per method. A rerun of payBack is a second call with the same key. */
  calls: Readonly<{ hold: number; refund: number; release: number }>;
};

export const RUN_ID = 'wfr_9k2';
export const SIGNAL = 'provider.refund.settled';
const SETTLED_AT = "{ settledAt: '2026-10-21T14:02:00Z' }";

const STARTED: readonly RunRow[] = [
  { type: 'RunStarted', node: '', note: "payments.refund v1 · input { paymentId: 'pay_3x', amount: 4800 }" },
  { type: 'NodeScheduled', node: 'hold', note: `key '${RUN_ID}:hold:do'` },
];
const HELD: readonly RunRow[] = [
  { type: 'NodeCompleted', node: 'hold', note: "result { holdId: 'hold_2q7' }" },
  { type: 'NodeScheduled', node: 'payBack', note: `key '${RUN_ID}:payBack:do'` },
];
const PAID_BACK: readonly RunRow[] = [
  { type: 'NodeCompleted', node: 'payBack', note: "result { refundId: 're_5t8' }, checked by output" },
  { type: 'Parked', node: 'settled', note: `waits for '${SIGNAL}' · timeout 3d` },
];
const FINISHED: readonly RunRow[] = [
  { type: 'NodeCompleted', node: 'settled', note: 'result: the signal payload' },
  { type: 'RunCompleted', node: '', note: `output { refundId: 're_5t8', settledAt: '2026-10-21T14:02:00Z' }` },
];
const CANCELLED: readonly RunRow[] = [
  { type: 'CancelRequested', node: '', note: "reason: 'customer withdrew'" },
  {
    type: 'CompensationStarted',
    node: '',
    note: 'undo runs newest first. payBack has no undo: skipped, kept in residual',
  },
  { type: 'NodeScheduled', node: 'hold', note: `phase: undo · key '${RUN_ID}:hold:undo'` },
  { type: 'NodeCompleted', node: 'hold', note: "phase: undo · payments.release('hold_2q7')" },
  { type: 'RunCancelled', node: '', note: "read(runId).residual: ['payBack']" },
];

/** One refund, parked, then settled by the provider's webhook. */
export const RUN_START: RunState = {
  phase: 'completed',
  rows: [
    ...STARTED,
    ...HELD,
    ...PAID_BACK,
    { type: 'SignalReceived', node: 'settled', note: `'${SIGNAL}' · ${SETTLED_AT}` },
    ...FINISHED,
  ],
  calls: { hold: 1, refund: 1, release: 0 },
};
const RUN_IDLE: RunState = { phase: 'idle', rows: [], calls: { hold: 0, refund: 0, release: 0 } };

const add = (state: RunState, rows: readonly RunRow[], patch: Partial<RunState> = {}): RunState => ({
  ...state,
  ...patch,
  rows: [...state.rows, ...rows],
});

export function runReducer(state: RunState, action: RunAction): RunState {
  const { phase, calls } = state;
  switch (action) {
    case 'start': {
      return { ...RUN_IDLE, phase: 'hold', rows: STARTED };
    }
    case 'tick': {
      if (phase === 'hold') return add(state, HELD, { phase: 'payBack', calls: { ...calls, hold: calls.hold + 1 } });
      if (phase === 'payBack') {
        return add(state, PAID_BACK, { phase: 'parked', calls: { ...calls, refund: calls.refund + 1 } });
      }
      return state;
    }
    case 'restart': {
      // The provider got the call; the process died before the checkpoint. The step runs again with the same key.
      if (phase !== 'payBack') return state;
      return add(
        state,
        [
          {
            type: null,
            node: '',
            note: `The server restarted. Nothing was written. The last checkpoint is NodeScheduled payBack, so a worker runs payBack again with key '${RUN_ID}:payBack:do'.`,
          },
        ],
        { calls: { ...calls, refund: calls.refund + 1 } },
      );
    }
    case 'signal':
    case 'race': {
      if (phase !== 'parked') return state;
      return add(
        state,
        [
          {
            type: 'SignalReceived',
            node: 'settled',
            note:
              action === 'race'
                ? 'The signal committed first. The timer was in flight and commits nothing: one of them wins.'
                : `'${SIGNAL}' · ${SETTLED_AT}`,
          },
          ...FINISHED,
        ],
        { phase: 'completed' },
      );
    }
    case 'wait': {
      if (phase !== 'parked') return state;
      return add(
        state,
        [
          { type: 'TimerFired', node: 'settled', note: '3 days passed' },
          { type: 'NodeFailed', node: 'settled', note: `waitFor 'settled' got no '${SIGNAL}' signal in time` },
        ],
        { phase: 'stuck' },
      );
    }
    case 'cancel': {
      if (phase !== 'parked' && phase !== 'stuck') return state;
      return add(state, CANCELLED, { phase: 'cancelled', calls: { ...calls, release: calls.release + 1 } });
    }
    case 'reset': {
      return RUN_IDLE;
    }
  }
}

/** The refunds the provider made: one, however often payBack ran, because every try sends the same key. */
export const refundsMade = (state: RunState): number => Math.min(state.calls.refund, 1);
