# @arki/bench

## 0.0.2

Fixed:

- A comparison from too few blocks no longer gets a verdict. A `quick` run times one block per case, and one block gave a zero-width bootstrap interval, so a single noisy sample read as "50× slower [50–50]". Each side now needs at least 2 blocks over all processes (`MIN_COMPARISON_BLOCKS`); below that `compareBlocks` and `compareMedians` return the point ratio, interval `[ratio, ratio]` and `inconclusive`, and `compareRuns` marks the row `inconclusive` instead of `regressed` or `improved`. Reports print `inconclusive (1 block)` and `1 block` in the interval column, also for results saved by 0.0.1. Sizes and deterministic metrics are exact and unchanged.

Added:

- `collectLosses(results)` and `renderLosses(losses, { format })`: every row where the suite's own library is slower, larger or higher than a competitor or a variant, across any number of saved results and every runtime of a matrix, worst first, with rough (not publishable) results marked.
- `arki-bench losses [results or directories…]`: reads `.bench/*.json` in the package, or `**/.bench/*.json` under a directory. `--markdown`, `--json`, `--no-variants`, and `--ci` (exit 1 on a loss in a publishable result).

## 0.0.1

First public release.

Added:

- Suites as data: `defineSuite` with `compare`, `scenario`, `size` and `metric` groups. `compare` groups carry a written, versioned contract that every ranked case must meet on every input before anything is timed. A case that keeps a different promise is `differs` (shown, never ranked), another way to call the baseline's library is `variant`.
- Timing on mitata, with fresh call sites per case, interleaved and shuffled blocks, an empty-function floor, untimed `setup`, awaited and possibly async `normalize`, and per-state `teardown`.
- Statistics: ratio of Σtime/Σops with a hierarchical bootstrap over processes and blocks, and verdicts against a ±2% equivalence band (lower, higher, tie, inconclusive). Profiles `quick`, `explore` and `publish` (fresh processes).
- Bundle size per case (JavaScript, CSS and assets, gzip and brotli per file) with `limit` budgets, and metric groups for any number you can collect (for example type-check instantiations).
- A versioned result schema with provenance (runtime, CPU, load, git revision, package versions, raw blocks), a deterministic README section with a freshness hash, `arki-bench check`, and `arki-bench compare --ci` for regressions.
- CLI `arki-bench` (`run`, `report`, `compare`, `check`, `list`, `doctor`) and a runtime matrix (`--runtime node,bun,deno`).
- The portable core runs on Node, Bun, Deno and browsers; `test:runtimes` checks each, plus Hermes when a binary is available.
