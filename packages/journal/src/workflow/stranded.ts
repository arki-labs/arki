import { JournalError } from '../errors.js';

/** The part of a run row that says which code it needs. */
type RunCode = {
  readonly id: string;
  readonly name: string;
  readonly workflowVersion: number;
  readonly shapeHash: string;
};

/**
 * The code a run goes on with, or the error that says why it cannot. A run is stranded when no code is registered for
 * its `(name, version)`, or the registered code has another shape than the run started with. Pure, so a read of
 * stranded runs can use the same test as the runner.
 */
export function codeOf<Def extends { readonly shapeHash: string }>(
  run: RunCode,
  registered: ReadonlyMap<string, Def>,
): Def | JournalError {
  const def = registered.get(`${run.name}@${run.workflowVersion}`);
  if (def === undefined) {
    return new JournalError(
      'WORKFLOW_UNKNOWN',
      'workflow',
      run.id,
      `no registered workflow "${run.name}" v${run.workflowVersion}`,
    );
  }
  if (def.shapeHash !== run.shapeHash) {
    return new JournalError(
      'WORKFLOW_SHAPE_CHANGED',
      'workflow',
      run.id,
      `"${run.name}" v${run.workflowVersion} has other nodes than this run started with`,
    );
  }
  return def;
}

/** A stranded run's job is dead at once: retrying it before the code is back would fail the same way. */
export const isStrandedError = (reason: unknown): boolean =>
  reason instanceof JournalError && (reason.code === 'WORKFLOW_UNKNOWN' || reason.code === 'WORKFLOW_SHAPE_CHANGED');
