/**
 * The journal chapter's two simulations as plain state machines: no React, so the test can read the rows they write.
 * Part 1 is `payOrder` from the `@arki/journal` README. Part 2 is the refund workflow of `@arki/payments`.
 * Every workflow event name below is a name `packages/journal/src/workflow/machine.ts` defines; the e2e test checks.
 */

export type Lit = 'on' | 'bad';

/* ───────────── Part 1: one transaction ───────────── */

type CommandStage = 'idle' | 'reading' | 'returned' | 'closed';
type Decision = 'pending' | 'commit' | 'rollback';

export type CommandState = {
  stage: CommandStage;
  /** The row is already paid, so the rule says no. */
  fail: boolean;
  decision: Decision;
};

export type CommandAction =
  { type: 'run' } | { type: 'commit' } | { type: 'rollback' } | { type: 'toggleFail' } | { type: 'reset' };

/** What a reader sees without JavaScript: the run already finished and committed. */
export const COMMAND_START: CommandState = { stage: 'closed', fail: false, decision: 'commit' };

export function commandReducer(state: CommandState, action: CommandAction): CommandState {
  switch (action.type) {
    case 'run': {
      if (state.stage === 'idle') return { ...state, stage: 'reading' };
      if (state.stage === 'reading') return { ...state, stage: 'returned' };
      return state;
    }
    case 'commit': {
      return { ...state, stage: 'closed', decision: 'commit' };
    }
    case 'rollback': {
      return { ...state, stage: 'closed', decision: 'rollback' };
    }
    case 'toggleFail': {
      return { stage: 'idle', fail: !state.fail, decision: 'pending' };
    }
    case 'reset': {
      return { ...state, stage: 'idle', decision: 'pending' };
    }
  }
}

export type CommandView = {
  /** The part of the `payOrder` excerpt that runs now, by part id. */
  lit: Readonly<Record<string, Lit>>;
  canRun: boolean;
  canDecide: boolean;
  runLabel: string;
  status: string;
  /** `committed`, `rolled` or empty: how the transaction box is drawn. */
  box: 'committed' | 'rolled' | 'open';
  boxLabel: string;
  /** How the four panes are drawn. */
  panes: 'committed' | 'staged' | 'empty';
  rowStatus: string;
  rowHot: boolean;
  event: string;
  projection: string;
  job: string;
  failed: boolean;
};

function commandStatus({ stage, fail, decision }: CommandState): string {
  switch (stage) {
    case 'idle': {
      return fail
        ? 'The row is already paid. Run payOrder to see the rule say no.'
        : 'The row is placed. Run payOrder.';
    }
    case 'reading': {
      return 'write() reads the orders row for input.orderId, inside a new transaction.';
    }
    case 'returned': {
      return fail
        ? 'The rule says no. The command returns CommandConflict. Nothing was written.'
        : 'The command returned [OrderPaid]. Four writes are staged in the same transaction. Commit or roll back.';
    }
    case 'closed': {
      return decision === 'commit' ? 'Committed: all four appeared together.' : 'Rolled back: none of the four exist.';
    }
  }
}

export function commandView(state: CommandState): CommandView {
  const { stage, fail, decision } = state;
  const staged = (stage === 'returned' || stage === 'closed') && !fail && decision !== 'rollback';
  const committed = stage === 'closed' && decision === 'commit' && !fail;
  const lit: Record<string, Lit> = {};
  if (stage === 'reading') lit.write = 'on';
  if (stage === 'returned') {
    if (fail) lit.conflict = 'bad';
    else lit.event = 'on';
  }
  if (stage === 'closed') lit.close = decision === 'commit' ? 'on' : 'bad';
  return {
    lit,
    canRun: stage === 'idle' || stage === 'reading',
    canDecide: stage === 'returned' && !fail,
    runLabel: stage === 'idle' ? 'Run payOrder' : 'Next line',
    status: commandStatus(state),
    box: committed ? 'committed' : stage === 'closed' ? 'rolled' : 'open',
    boxLabel:
      stage === 'idle'
        ? 'one transaction'
        : stage === 'closed'
          ? `one transaction · ${decision === 'commit' ? 'committed' : 'rolled back'}`
          : 'one transaction · open',
    panes: committed ? 'committed' : staged ? 'staged' : 'empty',
    rowStatus: fail || committed ? 'paid' : staged ? 'placed → paid' : 'placed',
    rowHot: staged,
    event: staged ? 'OrderPaid { amount: input.amount }' : '—',
    projection: staged ? 'handles OrderPlaced only: nothing to apply for OrderPaid' : '—',
    job: staged ? "order-mail · mailer.send({ template: 'order-paid', idempotencyKey: jobId })" : '—',
    failed: stage === 'returned' && fail,
  };
}

/* ───────────── Part 2: a workflow is rows too ───────────── */

type RefundStage = 'idle' | 'approved' | 'paid' | 'parked' | 'woken' | 'done';
type RefundPath = 'signal' | 'timeout';
/** The button that wrote the newest rows, so only those rows flash. */
type Touched = 'approve' | 'payBack' | 'retry' | 'wait' | 'wake' | 'record';

export type RefundState = {
  stage: RefundStage;
  path: RefundPath | null;
  retried: boolean;
  last: Touched | null;
};

export type RefundAction =
  | { type: 'approve' }
  | { type: 'payBack' }
  | { type: 'retry' }
  | { type: 'wait' }
  | { type: 'signal' }
  | { type: 'timeout' }
  | { type: 'record' }
  | { type: 'reset' };

/** What a reader sees without JavaScript: the refund finished on the webhook. */
export const REFUND_START: RefundState = { stage: 'done', path: 'signal', retried: false, last: null };

export function refundReducer(state: RefundState, action: RefundAction): RefundState {
  switch (action.type) {
    case 'approve': {
      return { ...state, stage: 'approved', last: 'approve' };
    }
    case 'payBack': {
      return { ...state, stage: 'paid', last: 'payBack' };
    }
    case 'retry': {
      return { ...state, retried: true, last: 'retry' };
    }
    case 'wait': {
      return { ...state, stage: 'parked', last: 'wait' };
    }
    case 'signal': {
      return { ...state, stage: 'woken', path: 'signal', last: 'wake' };
    }
    case 'timeout': {
      return { ...state, stage: 'woken', path: 'timeout', last: 'wake' };
    }
    case 'record': {
      return { ...state, stage: 'done', last: 'record' };
    }
    case 'reset': {
      return { stage: 'idle', path: null, retried: false, last: null };
    }
  }
}

export type JournalRow = {
  seq: number;
  entity: string;
  /** A domain event or command, or the name of a workflow event. */
  event: string;
  /** What the workflow event was about: a step, a signal or a timer. */
  detail?: string;
  kind: 'domain' | 'workflow';
  note: string;
  /** Written by the newest button, so it flashes. */
  fresh: boolean;
};

type RowDraft = Omit<JournalRow, 'seq' | 'fresh'> & { by: Touched };

const RUN = 'payments.refund run';
const STAGE_ORDER: readonly RefundStage[] = ['idle', 'approved', 'paid', 'parked', 'woken', 'done'];

/** The rows of one refund in the order the journal wrote them. */
export function refundRows({ stage, path, retried, last }: RefundState): readonly JournalRow[] {
  const reached = (target: RefundStage) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(target);
  const drafts: RowDraft[] = [];
  if (reached('approved')) {
    drafts.push(
      {
        by: 'approve',
        entity: 'refund',
        event: 'RefundApproved',
        kind: 'domain',
        note: 'the command that approved the refund',
      },
      {
        by: 'approve',
        entity: RUN,
        event: 'RunStarted',
        kind: 'workflow',
        note: 'startOn: same transaction as seq 1 · id = refundRunId(e.entityId)',
      },
    );
  }
  if (reached('paid')) {
    drafts.push(
      {
        by: 'payBack',
        entity: RUN,
        event: 'NodeCompleted',
        detail: 'begin',
        kind: 'workflow',
        note: 'reads paymentId, amountMinor, currency, reason',
      },
      {
        by: 'payBack',
        entity: RUN,
        event: 'NodeCompleted',
        detail: 'payBack',
        kind: 'workflow',
        note: 'provider.refundPayment(…, { idempotencyKey: key })',
      },
      {
        by: 'payBack',
        entity: 'refund',
        event: 'completeRefund',
        kind: 'domain',
        note: 'run(commands.completeRefund, …) inside the step · workflow.ts:184',
      },
    );
  }
  if (retried) {
    drafts.push({
      by: 'retry',
      entity: RUN,
      event: 'JobRetried',
      detail: 'payBack',
      kind: 'workflow',
      note: 'same idempotencyKey: Stripe answers with the first refund',
    });
  }
  if (reached('parked')) {
    drafts.push({
      by: 'wait',
      entity: RUN,
      event: 'Parked',
      detail: 'settled',
      kind: 'workflow',
      note: "waitFor signal 'stripe.refund.settled' · timeout 3d",
    });
  }
  if (reached('woken')) {
    drafts.push(
      path === 'signal'
        ? {
            by: 'wake',
            entity: RUN,
            event: 'SignalReceived',
            detail: 'stripe.refund.settled',
            kind: 'workflow',
            note: "runCommand(refundWorkflow.signal('stripe.refund.settled'), input) · services.ts:121",
          }
        : {
            by: 'wake',
            entity: RUN,
            event: 'TimerFired',
            detail: 'settled',
            kind: 'workflow',
            note: "3 days passed · onTimeout: 'continue'",
          },
    );
  }
  if (reached('done')) {
    drafts.push(
      {
        by: 'record',
        entity: RUN,
        event: 'NodeCompleted',
        detail: 'record',
        kind: 'workflow',
        note:
          path === 'signal' ? 'results.settled came from the signal' : 'no signal: record asks Stripe with findRefund',
      },
      {
        by: 'record',
        entity: RUN,
        event: 'NodeCompleted',
        detail: 'notify',
        kind: 'workflow',
        note: 'notifications, every method optional',
      },
      {
        by: 'record',
        entity: RUN,
        event: 'RunCompleted',
        kind: 'workflow',
        note: "output { providerRefundId, outcome: 'completed' }",
      },
    );
  }
  return drafts.map(({ by, ...row }, index) => ({ ...row, seq: index + 1, fresh: by === last }));
}

export type RefundView = {
  /** The parts of the workflow excerpt that run now, by part id. */
  lit: Readonly<Record<string, Lit>>;
  rows: readonly JournalRow[];
  status: string;
  parked: boolean;
  finished: boolean;
};

function refundStatus({ stage, path, retried }: RefundState): string {
  switch (stage) {
    case 'idle': {
      return 'Nothing has happened yet.';
    }
    case 'approved': {
      return 'RefundApproved and RunStarted were written in one transaction. The run is started exactly once.';
    }
    case 'paid': {
      return retried
        ? 'The retry used the same key. Stripe returned the first refund. No double payment.'
        : 'payBack called Stripe with idempotencyKey: key. Retry it to see the key at work.';
    }
    case 'parked': {
      return 'The run is parked. It waits for the signal, at most three days. No worker is busy.';
    }
    case 'woken': {
      return path === 'signal'
        ? 'The webhook sent the signal as a command. It is a row like any other.'
        : 'The timer fired. onTimeout is continue, so record runs and asks Stripe.';
    }
    case 'done': {
      return 'Done. Domain rows and workflow rows, one table, one order.';
    }
  }
}

export function refundView(state: RefundState): RefundView {
  const lit: Record<string, Lit> = {};
  if (state.stage === 'approved') lit.start = 'on';
  if (state.stage === 'paid') lit.key = 'on';
  if (state.stage === 'parked') lit.wait = 'on';
  if (state.stage === 'woken') {
    if (state.path === 'signal') lit.signal = 'on';
    else lit.timeout = 'on';
  }
  return {
    lit,
    rows: refundRows(state),
    status: refundStatus(state),
    parked: state.stage === 'parked',
    finished: state.stage === 'done',
  };
}
