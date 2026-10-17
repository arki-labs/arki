/** Every container this package starts carries this label, so a leak is findable and testable. */
export const RUN_LABEL = 'arki-testing-run';

/** A run id as a safe part of a database or container name. */
export function safeId(runId: string): string {
  return runId.toLowerCase().replaceAll(/[^a-z0-9]/g, '_');
}

/** Stops a thing at most once, whatever the caller does. */
export function once(stop: () => Promise<unknown>): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => (stopping ??= stop().then(nothingToStop));
}

/** A `stop` for a piece that holds nothing. */
export const nothingToStop = (): Promise<void> => Promise.resolve();
