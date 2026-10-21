/**
 * The run states and step statuses, written once. The table columns (`pg.ts`), the read types (`read.ts`) and the
 * Foreman schemas (`foreman/workflows.ts`) all derive from these arrays.
 */

/** Every state `workflow_runs.state` stores. */
export const RUN_STATES = ['running', 'parked', 'compensating', 'completed', 'failed', 'cancelled'] as const;

/** Every status `workflow_steps.status` stores. */
export const STEP_STATUSES = ['scheduled', 'done', 'skipped', 'failed'] as const;

/** A stored status plus `running`, which is never stored: a reader derives it from the step's job. */
export const STEP_VIEW_STATUSES = [...STEP_STATUSES, 'running'] as const;

/**
 * What a signal delivery reports. `kept`: stored, the run is not waiting for it yet. `woke`: stored and the run moved
 * on. `duplicate`: this delivery was seen. `finished`: the run is over, so it is dropped. `no-run`: a definition's
 * `def.signal` named no run of its own workflow, so nothing is stored (the operator verb refuses instead).
 */
export const SIGNAL_STATUSES = ['kept', 'woke', 'duplicate', 'finished', 'no-run'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Every phase `workflow_steps.phase` stores: `do` runs the step, `undo` compensates it. */
export const STEP_PHASES = ['do', 'undo'] as const;
export type StepPhase = (typeof STEP_PHASES)[number];

/** Where a cancel leaves a run: `compensating` while it undoes its steps, `cancelled` when there was nothing to undo. */
export const CANCEL_STATES = ['compensating', 'cancelled'] as const satisfies readonly (typeof RUN_STATES)[number][];

/**
 * Why a node was skipped, for code to act on (`reason` is the text for people): `when` (its condition was false),
 * `compensating` (the run began compensating before the node ran: it has no result), `no-undo` (the step declares no
 * undo), `detached` (a detached child is left running), `operator` (`skipUndo`).
 */
export const SKIP_CAUSES = ['when', 'compensating', 'no-undo', 'detached', 'operator'] as const;
