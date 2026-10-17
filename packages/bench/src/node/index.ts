/**
 * `@arki/bench/node`: the host side. Run a suite file in fresh processes, collect provenance, measure bundle
 * sizes and write the README section.
 */
export { runFile, type RunFileOptions, type Runtime } from './run.js';
export { collectProvenance } from './provenance.js';
export { createSizeRunner } from './size.js';
export { checkReadme, writeReadme } from './readme.js';
