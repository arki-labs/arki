# @arki/bench

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
