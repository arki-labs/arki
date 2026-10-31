# @arki/bench

## 0.2.0

### Minor Changes

- 164e25a: Breaking: `parseSize` now returns `{ bytes }` or `{ problem }` (the part that did not parse) instead of a number or `undefined`.

  - A missing suite file, no installed runtime, a failed worker, a failed bundle and a `suite` file without a default export now throw `BenchRunError`, so `arki-bench` prints the message and exits 1 instead of ending with an unhandled rejection. `BenchRunError` is a class now, not an `Error` renamed by string.
  - `writeReadme` throws `ReadmeError` and `checkReadme` returns a `reason` when the README cannot be read or written (a directory, no permission), instead of raw `EISDIR` / `EACCES`.

  No docs impact beyond the README row for `parseSize`, updated here. No demo impact.

## 0.1.0

### Minor Changes

- b0a9677: Choose the Node you measure on, and know when it is the wrong one. `--node <path>` (or `ARKI_BENCH_NODE`) sets the Node binary for the Node leg; the default is the Node running `arki-bench`. When the project declares a Node version (`.nvmrc`, `.node-version`, `volta.node` or `engines.node`, found by walking up from the bench file) and the Node that ran does not meet it, the result gets a blocking `node-version-mismatch` warning naming both versions, so it is marked NOT PUBLISHABLE. A `--node` path that does not exist is a `runtime-missing` warning.

### Patch Changes

- 7922fb5: Docs standard: README reordered with install, quick start, limits and failure behaviour; `AGENTS.md`, `llms.txt` and `docs/agent-guide.md` added; the quick start is now a tested example file.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

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
