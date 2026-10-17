/**
 * `@arki/bench/core`: the portable engine. Run a suite, assess the result, compare runs and render reports
 * without touching files or processes.
 */
export * from './types.js';
export {
  compare,
  defineSuite,
  metric,
  parseSize,
  scenario,
  size,
  specHash,
  validateSuite,
  workHash,
  SpecError,
} from './spec.js';
export { assessResult, BLOCKING_WARNINGS, PROFILE_BUDGETS, runSuite } from './engine.js';
export { collectLosses } from './losses.js';
export {
  compareBlocks,
  compareMedians,
  compareRuns,
  createRandom,
  DEFAULT_SEED,
  MIN_COMPARISON_BLOCKS,
  summarize,
  summarizeValues,
} from './stats.js';
export { renderLosses, renderMarkdown, renderText, renderComparison } from './report/index.js';
