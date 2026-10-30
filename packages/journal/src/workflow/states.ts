/**
 * The run states and step statuses, written once. The table columns (`pg.ts`), the read types (`read.ts`) and the
 * Foreman schemas (`foreman/workflows.ts`) all derive from these arrays.
 */

/**
 * Every state `workflow_runs.state` stores. `queued`: a limit was busy and the workflow's `onBusy` is `'queue'`, so
 * the run waits for a slot; it is unfinished but holds none. `expired`: the run's `ttl` passed before its first node
 * started, so it never ran. A delayed run is `running`: a reader derives `delayedUntil` from `start_at`.
 */
export const RUN_STATES = [
  'queued',
  'running',
  'parked',
  'compensating',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;

/** The states a run never leaves. `def.settled` returns the run once it is in one of them. */
export const ENDED_STATES = ['completed', 'failed', 'cancelled', 'expired'] as const;

/** Every status `workflow_steps.status` stores. */
export const STEP_STATUSES = ['scheduled', 'done', 'skipped', 'failed'] as const;

/** A stored status plus `running`, which is never stored: a reader derives it from the step's job. */
export const STEP_VIEW_STATUSES = [...STEP_STATUSES, 'running'] as const;
/** What a step row stores, plus `running`, which is never stored: it is derived from the step's job. */
export type StepStatus = (typeof STEP_VIEW_STATUSES)[number];

/**
 * What a signal delivery reports. `kept`: stored, the run is not waiting for it yet. `woke`: stored and the run moved
 * on. `duplicate`: this delivery was seen. `finished`: the run is over, so it is dropped. `no-run`: a definition's
 * `def.signal` named no run of its own workflow, so nothing is stored (the operator verb refuses instead).
 */
export const SIGNAL_STATUSES = ['kept', 'woke', 'duplicate', 'finished', 'no-run'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Why a limit refuses a start (`WorkflowBusy.reason`): it is `full`, or an operator `paused` it. */
export const LIMIT_BUSY_REASONS = ['full', 'paused'] as const;

/**
 * What a start does when a limit it holds is busy (`concurrency.onBusy`): `refuse` returns `WorkflowBusy`, `join`
 * answers the oldest running run of the key, `queue` creates the run `queued` until a slot frees.
 */
export const ON_BUSY = ['refuse', 'join', 'queue'] as const;

/**
 * When `startOn` starts a run (`startOn.timing`). `after-commit`: the start job commits with the event, and the run
 * starts later. `with-event`: `RunStarted`, the first scheduled node and its job are written in the event's
 * transaction, so a rollback removes the run and a reader sees it when the command returns. No body runs inline.
 */
export const START_TIMINGS = ['after-commit', 'with-event'] as const;

/** Every phase `workflow_steps.phase` stores: `do` runs the step, `undo` compensates it. */
export const STEP_PHASES = ['do', 'undo'] as const;
export type StepPhase = (typeof STEP_PHASES)[number];

/** Where a cancel leaves a run: `compensating` while it undoes its steps, `cancelled` when there was nothing to undo. */
export const CANCEL_STATES = ['compensating', 'cancelled'] as const satisfies readonly (typeof RUN_STATES)[number][];

/**
 * Why a node was skipped, for code to act on (`reason` is the text for people): `when` (its condition was false),
 * `compensating` (the run began compensating before the node ran: it has no result), `no-undo` (the step declares no
 * undo), `detached` (a detached child is left running), `operator` (`skipUndo`), `expired` (the run's `ttl` passed
 * before its first node ran: it has no result).
 */
export const SKIP_CAUSES = ['when', 'compensating', 'no-undo', 'detached', 'operator', 'expired'] as const;
