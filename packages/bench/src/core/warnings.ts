// Its own module so `collectLosses` (exported from the suite entry point too)
// can name the blocking codes without importing the engine and mitata.

/**
 * Warning codes that make a result not publishable. Every other code
 * (`package-version-unknown`, `inputs-shared`) is advice.
 */
export const BLOCKING_WARNINGS: readonly string[] = [
  'quick-profile',
  'explore-profile',
  'filtered',
  'contract-failed',
  'optimized-out',
  'floor-unreliable',
  'unstable',
  'state-mutated',
  'teardown-failed',
  'size-skipped',
  'size-unavailable',
  'runtime-missing',
  'node-version-mismatch',
  'busy-machine',
];
