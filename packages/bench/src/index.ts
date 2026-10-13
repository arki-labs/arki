// What a benchmark file needs: define suites and groups. Running, reporting
// and comparing live in `@arki/bench/core` (portable) and `@arki/bench/node`
// (files, processes, bundling, README writing, CLI).
export { compare, defineSuite, metric, scenario, size } from './core/spec.js';
export type * from './core/types.js';
