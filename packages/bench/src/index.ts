// What a benchmark file needs: define suites and groups. Running, reporting
// and comparing live in `@arki/bench/core` (portable) and `@arki/bench/node`
// (files, processes, bundling, README writing, CLI).
export { compare, defineSuite, metric, scenario, size } from './core/spec.js';
// Losses read saved results only: no engine, no mitata.
export { collectLosses } from './core/losses.js';
export { renderLosses } from './core/report/losses.js';
export type * from './core/types.js';
