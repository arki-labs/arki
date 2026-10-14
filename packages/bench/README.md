# @arki/bench

Benchmarks you can publish. You declare what a library and its competitors must return, and `@arki/bench` checks that every case does the same work before it times anything. It then measures with [mitata](https://github.com/evanwashere/mitata) in interleaved, randomized blocks across fresh processes, reports every number with a 95% interval, records the exact versions and machine, and writes the table into your README from a saved result. CI can compare two runs, fail on regressions and size budgets, and fail when the README no longer matches the suite.

```sh
bun add -D @arki/bench    # or: npm i -D @arki/bench
```

## Quickstart

`bench/sum.bench.ts`:

```ts
import { compare, defineSuite } from '@arki/bench';

export default defineSuite({
  id: 'my-lib',
  groups: [
    compare({
      id: 'sum',
      title: 'Sum an array',
      contract: { id: 'sum/v1', description: 'the sum of the numbers' },
      inputs: [[1, 2, 3], [], [-1, 1], [0.1, 0.2]],
      expected: xs => xs.reduce((a, b) => a + b, 0),
      baseline: 'loop',
      cases: {
        loop: {
          run: (xs: number[]) => {
            let s = 0;
            for (const x of xs) s += x;
            return s;
          },
        },
        reduce: { run: (xs: number[]) => xs.reduce((a, b) => a + b, 0) },
      },
    }),
  ],
});
```

```sh
arki-bench
```

prints something like:

```text
Benchmarks  my-lib
Node 22.13.1 · darwin arm64 · Apple M2 Max (12 cores) · explore · 1 process × 10 blocks · seed 1592639052

Sum an array  sum
  contract sum/v1: every ranked row returns the sum of the numbers · ✓ checked on 4 inputs
  library  version  time/op                       vs loop
  loop               4.12 ns ±2%  ████████████     1.00× baseline
  reduce             5.31 ns ±3%  ███████████████▌ 1.3× slower [1.2–1.4]
```

With no arguments, `arki-bench` finds `bench/**/*.bench.{ts,mts,js,mjs}` under the nearest `package.json`, runs them with the `explore` profile, prints a table and saves the result to `.bench/<suite-id>.json`. Add `.bench/` to `.gitignore`, or commit it if you want the raw data next to the README.

`arki-bench` needs Node 22.10 or later (`engines.node` is `>=22.10`), Bun, or Deno. TypeScript suites run natively under Bun and Deno. Under Node older than 22.18, `arki-bench` adds `--experimental-strip-types` for you.

## Core concepts

### Contracts and equal work

A `compare` group ranks cases only when they do the same work. The `contract` says, in words, what every ranked case returns. Before timing, every case runs on every input and its result (after `normalize`) must equal `expected(input)`, or the baseline's result when there is no oracle. A group whose check fails is not timed, and the run is not publishable.

Results are compared by value: Date by time, RegExp by source and flags, typed arrays, `ArrayBuffer` and `DataView` by bytes, Map and Set entry by entry (each entry matched once), arrays, plain objects and class instances by their own enumerable fields. A value with no data to compare (a function, a Promise, a WeakMap, an instance that keeps its state in private fields) equals only itself, and the check failure says so: map it to plain data with `normalize`.

Cases cannot change each other's inputs. `expected` runs first, on a pristine `structuredClone` of each input, and every case gets its own clone, in the check and for timing. Inputs a clone would change (class instances, null-prototype objects, functions) are shared instead, with a non-blocking `inputs-shared` warning: build such objects in `setup`. After timing, each ranked case runs once more on the very states it was timed on. If the answer changed, `run()` mutated its input while being timed, and the run gets a blocking `state-mutated` warning: give each call fresh state or do not mutate.

Include the inputs that tell implementations apart: rounding ties, negative numbers, empty input, unicode. The inputs are also cycled during timing, so the engine cannot fold a constant.

A case that does similar but not equal work declares it:

```ts
naive: { run: x => Math.round(x * 100) / 100, differs: 'rounds half-up only' },
```

It is measured and shown as `different contract: rounds half-up only`, skipped by the check, and never ranked. Another way to call the baseline's own library (`variant: true`) is shown next to it, not ranked against competitors.

Change the contract id (`sum/v1` → `sum/v2`) when the work changes. `compare` refuses to compare runs whose contract ids differ.

### compare vs scenario

- `compare` — same work, ranked against a baseline, ratios with intervals.
- `scenario` — different work shown side by side (cold start vs warm call, small vs large input). No ratios, no ranking.
- `size` — bundle cost of an import (see [Size budgets](#size-budgets)).
- `metric` — any number you can collect (see [Metrics](#metrics)).

`setup` runs untimed and turns an input into the state `run` receives. `run` is timed and must return its result: the result goes to mitata's sink so the work cannot be optimized away. Use the builder form when you want `setup`'s return type to flow into `run`:

```ts
cases: c => ({
  parse: c({ setup: (s: string) => s.trim(), run: s => JSON.parse(s) }),
}),
```

In the default `mode: 'sync'`, `run` returns its result; a `run` that returns a promise is an error, because only the synchronous start of the work would be timed. In `mode: 'async'` every call is awaited, so `run` may return a promise or a plain value. In async mode `normalize` receives the awaited result, and it may itself return a promise (for example to read a `Response` body).

`setup` is synchronous: returning a promise is an error. Open async resources at module load or in a top-level `await`.

`teardown` runs untimed, once per state, after the contract check and after timing, even when timing fails or a later `setup` throws. Every state is torn down even when another `teardown` throws. A teardown error fails the case in the check; after timing it adds a blocking `teardown-failed` warning. Use it to close what `setup` opened, such as a database connection or a server.

### Baseline and verdicts

Every ratio is `case / baseline` with a 95% interval. The verdict words are:

| Verdict                     | Meaning                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `3.2× slower [3.0–3.4]`     | The interval excludes 1 and the ±2% equivalence band.                            |
| `1.8× faster [1.7–1.9]`     | Same, the other way. Faster rows show the speed-up factor.                       |
| `≈ same`                    | The interval lies inside ±2%. A tiny but certain difference is a tie, not a win. |
| `inconclusive [0.90–1.30×]` | The data cannot tell. A low point estimate is not a winner.                      |

A timed row needs at least 2 blocks on each side, over all processes (`MIN_COMPARISON_BLOCKS`), before it can get a verdict. One block has nothing to resample, so a `quick` run, which times one block per case, gives every ratio `inconclusive`: reports print `inconclusive (1 block)` and the interval column says `1 block`. In the saved result such a comparison keeps its point `ratio`, and its `interval` is `[ratio, ratio]`, which here means "not measured", not "exact". Repeated metrics follow the same rule; sizes and deterministic metrics are exact and need none. Reports and `losses` apply the rule to older results too, whatever verdict they recorded.

No report ever names a "fastest" case. Size groups say `smaller` / `larger`, metric groups `lower` / `higher`. The saved result uses one vocabulary for every kind (lower is better everywhere): `lower`, `higher`, `tie`, `inconclusive`. Exact ratios (sizes, deterministic metrics) use the same ±2% band.

Rows are also flagged:

- `⚠ optimized out` — the case is within noise of an empty function. Make `run` depend on its state and return the result.
- `⚠ unstable` — the block-to-block (or repeat-to-repeat, for metrics) variation is above the profile's limit (10% explore, 5% publish).
- `over budget` — a size above its `limit`. It is flagged and fails `--ci` and `compare`; it does not block publishing.

### Profiles

| Profile             | Design                                                                  | Use                                                |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `quick`             | 1 round of 10 ms blocks                                                 | Smoke test that the suite runs. Never publishable. |
| `explore` (default) | 1 process × 10 rounds of 100 ms blocks per case, after a 100 ms warm-up | Development. Never publishable.                    |
| `publish`           | 5 fresh processes × 10 rounds                                           | READMEs and CI. The only publishable profile.      |

In each round every case gets one block, in a seeded random order. Drift from heat, load or GC spreads over every case instead of hitting one. The seed is recorded; `--seed` replays the same order. `--processes` works in every profile: fresh processes help an explore run too.

### Why intervals

One number from one run cannot say whether a 4% difference is real. The interval comes from the run design: a two-stage bootstrap that resamples processes, then blocks within each process. The estimate is total time over total operations, so stalls the work really pays for are counted.

Only a `publish` run can be publishable. It is not when a contract failed, a row is `optimized out` or `unstable`, the floor was disturbed, a case mutated its state or failed to tear down, the run was filtered, a size group was skipped or unmeasured, a runtime of the matrix was missing, Node was not the version the project targets, or the machine was busy (1-minute load above half the cores, checked in every profile; a suite of only size and deterministic metric groups is exempt, since load cannot change them). `warnings` says which; the codes that block are exported as `BLOCKING_WARNINGS`. After merging fresh processes, the host derives every flag, warning and `publishable` again from the merged data with the same rules (`assessResult`).

## The README section

Put two markers in your README where the section goes:

```md
<!-- bench:start -->
## Benchmarks

What the portable core adds to a browser bundle (minified, then compressed file by file), next to the timing libraries people reach for. Timing itself is mitata: `@arki/bench` calls its `measure`, so per-operation overhead is the same.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.2 (mitata 1.0.34) · publish, seed 1592639052 · commit eeb0867c7e · 2026-10-13.

Versions: @arki/bench 0.0.2 · mitata 1.0.34 · tinybench 6.2.1.

### Define, run and render a suite

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/bench/core |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/bench/core** | 0.0.2 | 19.1 kB | 17.1 kB | 55.4 kB | 21 kB | baseline |
| mitata (bench, run) | 1.0.34 | 13 kB | 11.7 kB | 41.6 kB | — | different contract: timing and console output only |
| tinybench (Bench) | 6.2.1 | 6.42 kB | 5.77 kB | 20.5 kB | — | different contract: timing and a results table only |

**Notes**

- The rivals are timing libraries only. They have no contract check, no bootstrap intervals, no verdicts and no README rendering, so they are shown but not ranked.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/bench","specHash":"aaaf231c94631308","profile":"publish","date":"2026-10-13T11:41:19.933Z","harness":"0.0.2"} -->
<!-- bench:end -->
```

Then:

```sh
arki-bench --profile publish --write-readme
```

The section has the heading, your intro, one line of environment (runtime, OS, CPU, harness version, processes × blocks, seed, commit, date), the competitor versions, one table per group with the contract sentence, your notes, a reproduce line, and a meta line:

```md
| Library         | Version | Time / op | 95% interval | vs @arki/money                          |
| --------------- | ------- | --------: | ------------ | --------------------------------------- |
| **@arki/money** | 1.2.0   |    412 ns | 400–424 ns   | baseline                                |
| dinero.js       | 2.0.0   |   1.32 µs | 1.28–1.36 µs | 3.2× slower [3.0–3.4]                   |
| naive           | —       |     90 ns | 87–93 ns     | different contract: rounds half-up only |

<!-- bench:meta {"schema":1,"suite":"@arki/money","specHash":"…","profile":"publish","date":"…","harness":"0.0.1"} -->
```

- `--write-readme` refuses a result that is not publishable and lists why. `--force` writes it anyway, with a `Not publishable` block under the heading.
- Rendering is deterministic: `arki-bench report .bench/money.json --write README.md` rebuilds the section from a saved result without measuring again.
- `arki-bench check` imports the suites (it measures nothing) and exits 1 when the section is missing or the suite changed since it was generated. Run it in CI.
- The markers must appear exactly once each, start before end. Anything else is an error, never a guess.
- Change the reproduce line with `--reproduce <markdown>`, or drop it with `--reproduce ''`.

## CI recipe

Timings from different machines are not comparable, so measure base and head on the same runner, one after the other:

```yaml
# .github/workflows/bench.yml
name: bench
on: pull_request
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile

      - name: Base
        run: |
          git checkout ${{ github.event.pull_request.base.sha }}
          bun install --frozen-lockfile
          bunx arki-bench --profile publish --out /tmp/base.json
      - name: Head
        run: |
          git checkout ${{ github.event.pull_request.head.sha }}
          bun install --frozen-lockfile
          bunx arki-bench --profile publish --out /tmp/head.json --ci

      - run: bunx arki-bench compare /tmp/base.json /tmp/head.json --ci
      - run: bunx arki-bench check
```

Base and head must use the same profile: rows from different profiles are `incompatible`. The head step's `--ci` fails a head that is not publishable; a base that is not publishable only prints a warning under the comparison.

`compare` prints one row per case:

```text
group/case   base     head     change [95% interval]  status
round/arki   412 ns   470 ns   +14% [+10%, +18%]      regressed
round/big    227 ns   226 ns   -0.4% [-2.0%, +1.0%]   within tolerance

FAIL — 1 regressed beyond 5% · 1 within tolerance
```

Statuses: `regressed` and `improved` (the interval is beyond the threshold), `within tolerance`, `inconclusive`, `incompatible` (different contract, runtime, unit or profile, or the case's work changed: needs a new baseline, not a speed-up), `added`, `removed`, and `contract failed` (the head's contract check failed: one `group/(contract)` row, and the comparison fails). Compatibility is judged per case from its `workHash`, so adding a competitor or renaming a label keeps every other row comparable. Every head size row is checked against its budget, whatever its status: over it, the row is `regressed`. Repeated metrics compare their medians. `--threshold 3%` changes the band; `--format markdown` gives a table for a PR comment. `compare` fails on a regression or a failed head contract. `run --ci` fails on a failed contract, a size over budget, or a `publish` run that is not publishable.

A row with fewer than 2 blocks on either side is `inconclusive` (`1 block: too few to compare`), never `regressed` or `improved`.

Shared CI runners are noisy. Treat their numbers as a regression alarm, and publish README numbers from a quiet machine (`arki-bench doctor` tells you what to close).

## Finding losses

Where is our library slower, larger or higher than a rival? `losses` reads saved results and lists every row where the other side costs less:

```sh
arki-bench losses                 # .bench/*.json in this package
arki-bench losses .               # every **/.bench/*.json below (node_modules and hidden directories skipped)
arki-bench losses packages --markdown > losses.md
```

```text
Losses  3 losses in 2 suites · 1 from rough results (not publishable)

Competitors: a rival costs less than our library
  suite        runtime  group     ours         cheaper  ours is                source
  @arki/money  node     bundle    @arki/money  dinero   4.0× larger (exact)    publishable
  @arki/date   bun      parse     @arki/date   luxon    2.5× slower [2.3–2.8]  rough: quick profile / busy machine

Variants: another way to call our own library costs less
  suite        runtime  group     ours         cheaper     ours is                source
  @arki/money  node     allocate  @arki/money  arki split  1.3× slower [1.2–1.3]  publishable
```

A loss is a comparison with verdict `lower` (the other row is faster, smaller or lower) in a group whose baseline is the suite's own library: its `package` is the suite id, or it names no package. `differs` rows do other work and never count; neither do ties, inconclusive rows or one-block rows. Each runtime of a matrix is read on its own. Variants are listed in their own section because they are our own slow paths: a cheaper way to call the same library. `--no-variants` hides them.

Rows from a result that is not publishable are listed as rough, with the reason. In CI, `--ci` exits 1 when a listed loss comes from a publishable result; a rough result alone never fails:

```yaml
- run: bunx arki-bench --profile publish
- run: bunx arki-bench losses --ci
```

`--markdown` prints a table for an issue or a PR, `--json` the `Loss[]` that `collectLosses` returns.

## Size budgets

```ts
import { size } from '@arki/bench';

size({
  id: 'bundle',
  title: 'Bundle size',
  baseline: 'arki',
  externals: ['react', 'react-dom', 'react/jsx-runtime', 'bun:*'], // the default
  cases: {
    arki: { package: '@arki/ui', source: "export { Button } from '@arki/ui/button';", limit: '8 kB' },
    radix: { package: '@radix-ui/themes', source: "export { Button } from '@radix-ui/themes';" },
    css: { source: "@import '@arki/ui/styles.css';", ext: 'css' },
  },
});
```

Each case is bundled on its own with Bun's bundler (minified, for the browser) and reported as raw, gzip and brotli bytes of every emitted JS and CSS file. The default externals leave out React and every `bun:*` module (Bun's bundler refuses `bun:jsc` for the browser even when a package guards the import at runtime, as mitata does). A group's own `externals` replaces the defaults; it does not add to them. `limit` is a budget on the gzip total; over it, the row is flagged and `--ci` fails. Size groups need Bun on `PATH`; without it they are skipped with a warning that blocks publishing.

## Metrics

Anything you can count or time yourself:

```ts
import { metric } from '@arki/bench';

metric({
  id: 'types',
  title: 'Type instantiations',
  unit: 'instantiations',
  deterministic: true, // collected once; otherwise repeated and summarized with an interval
  baseline: 'arki',
  cases: {
    arki: { collect: () => countInstantiations('fixtures/arki.ts') },
    zod: { collect: () => countInstantiations('fixtures/zod.ts') },
  },
});
```

Lower is better for every metric. `collect()` must return a finite number ≥ 0; anything else fails the run with a message naming the case.

The estimate is the median of the collected values, everywhere: the table, the ratio against the baseline (a bootstrap of the ratio of medians; exact when `deterministic`), and `compare`. A repeated metric whose spread is above the profile's cv limit is flagged `unstable`, like a timed case. Each collected value is kept in the result (see [Result schema](#result-schema)), so a run with several processes merges every value.

## Runtime matrix

```sh
arki-bench --profile publish --runtime node,bun,deno
```

The same file runs under each runtime. The result keeps one result per runtime in `runtimes`, and the table gets one column per runtime. Ratios compare libraries within one runtime; the columns are not comparable to each other (Node and Deno run V8, Bun runs JavaScriptCore). The matrix is publishable only when every runtime is; its `warnings` are the union, each with the `runtime` it came from. A runtime that is not installed is skipped with a `runtime-missing` warning, which blocks publishing.

### Which Node it measures

The Node leg runs on the Node that runs `arki-bench` (`process.execPath`). The `#!/usr/bin/env node` line picks whichever `node` is first on `PATH`, which may not be the Node your project targets. Pick one on purpose:

```sh
arki-bench --node /opt/homebrew/opt/node@26/bin/node
ARKI_BENCH_NODE=/path/to/node arki-bench --runtime node,bun
```

`--node` wins over `ARKI_BENCH_NODE`. A path that does not exist is a `runtime-missing` warning, not a silent run on another Node. The report header names the version that ran, for example `Node 26.11.0`.

The project says which Node it targets in one of these, found by walking up from the bench file: `.nvmrc`, `.node-version`, `package.json` `volta.node`, then `package.json` `engines.node`. A pin file or `volta` anywhere up the tree wins over `engines`, which usually says what a library supports rather than what to measure on. Plain versions (`v26`, `26.1`), `^`, `~`, comparators (`>=22.10 <27`), `x` wildcards and `||` are understood; a value like `lts/*` is ignored. When the Node that ran does not meet it, the result carries a `node-version-mismatch` warning naming both versions and the file, and is not publishable.

## Commands

| Command                                      | What it does                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `arki-bench [run] [files…]`                  | Run suites. `--profile`, `--filter group[/case]`, `--seed`, `--processes`, `--runtime`, `--timeout`, `--out`, `--json` (always an array), `--markdown`, `--write-readme [path]`, `--reproduce`, `--force`, `--ci`, `--no-samples`, `--no-color`. |
| `arki-bench report <result.json>`            | Render a saved result: `--format text\|markdown\|json`, `--write README.md`, `--force`.                                                                                                                                                          |
| `arki-bench compare <base.json> <head.json>` | Case-by-case comparison: `--threshold 5%`, `--format text\|markdown`, `--ci`.                                                                                                                                                                    |
| `arki-bench losses [results or dirs…]`       | Where our library costs more than another row, across saved results: `--markdown`, `--json`, `--ci`, `--no-variants`.                                                                                                                            |
| `arki-bench check [README.md]`               | Exit 1 when the README section is missing or stale.                                                                                                                                                                                              |
| `arki-bench list`                            | Suites, groups, cases, contracts. `--json`.                                                                                                                                                                                                      |
| `arki-bench doctor`                          | Runtime, timer resolution, GC, CPU, load, Bun/Deno on PATH, and what to fix.                                                                                                                                                                     |

`--write-readme` takes the next word as its path unless it starts with `-` or is a suite file (`*.bench.*`). `report` and `compare` validate the whole saved result (structure, numbers, interval order, unique ids) and name the file and the first bad path.

Every command has `--help` with examples. Unknown options are rejected with a suggestion (`--profle` → `Did you mean --profile?`). Data goes to stdout, progress to stderr. Exit codes: 0 ok, 1 a check failed, 2 bad command line.

## API

Three entry points. A suite file only needs the first.

```ts
// @arki/bench — declare suites
import { compare, defineSuite, metric, scenario, size } from '@arki/bench';
// @arki/bench/core — portable (Node, Bun, Deno, browsers, Hermes): run and report
import { compareRuns, renderComparison, renderMarkdown, renderText, runSuite } from '@arki/bench/core';
// @arki/bench/node — files, processes, bundling, README
import { checkReadme, createSizeRunner, runFile, writeReadme } from '@arki/bench/node';

const result = await runSuite(suite, { profile: 'explore', seed: 1 });
console.log(renderText(result));

const published = await runFile('bench/money.bench.ts', { profile: 'publish', processes: 5 });
writeReadme('README.md', renderMarkdown(published));
```

`@arki/bench` exports `defineSuite`, `compare`, `scenario`, `size`, `metric`, `collectLosses`, `renderLosses` and every type below.

`@arki/bench/core` (portable):

| Export                                  | Signature                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `defineSuite`                           | `(spec: SuiteSpec) => SuiteSpec`                                                                                 |
| `compare`, `scenario`, `size`, `metric` | Identity helpers that set `kind` and infer case types.                                                           |
| `validateSuite`                         | `(spec) => void`; throws `SpecError` with every problem in `problems`.                                           |
| `SpecError`                             | `Error` with `problems: readonly string[]`.                                                                      |
| `parseSize`                             | `(limit: string) => number \| undefined`: `'8 kB'` → 8000, `'10 KiB'` → 10240.                                   |
| `specHash`                              | `(suite) => string`: hash of everything the suite declares (README freshness).                                   |
| `workHash`                              | `(group, key) => string`: hash of what one case measures (CI compatibility).                                     |
| `runSuite`                              | `(suite, options?: RunOptions) => Promise<BenchResult>`. Prints nothing.                                         |
| `PROFILE_BUDGETS`                       | `Record<Profile, Budget>`: rounds, block and warm-up time, min samples, cv limit and metric repeats per profile. |
| `assessResult`                          | `(result, { maxCv? }) => BenchResult`: derives flags, warnings and `publishable` from the data.                  |
| `BLOCKING_WARNINGS`                     | `readonly string[]`: warning codes that make a result not publishable.                                           |
| `summarize`, `summarizeValues`          | Statistics on raw blocks, or on repeated values (median).                                                        |
| `compareBlocks`, `compareMedians`       | `(base, other, { seed?, threshold? })`: ratio, 95% interval and verdict of Σns/Σops, or of medians.              |
| `MIN_COMPARISON_BLOCKS`                 | `2`: blocks (or metric observations) each side needs before a sampled comparison gets a verdict.                 |
| `compareRuns`                           | `(base, head, { threshold?, seed? }) => RunComparison`                                                           |
| `createRandom`, `DEFAULT_SEED`          | The seeded PRNG (mulberry32) and the default seed.                                                               |
| `renderText`                            | `(result, { color? }) => string`                                                                                 |
| `renderMarkdown`                        | `(result, { reproduce? }) => string`                                                                             |
| `renderComparison`                      | `(comparison, 'text' \| 'markdown') => string`                                                                   |
| `collectLosses`                         | `(results: readonly BenchResult[]) => Loss[]`: rows where our library costs more, worst first.                   |
| `renderLosses`                          | `(losses, { format: 'text' \| 'markdown' }) => string`                                                           |

`@arki/bench/node` (host):

| Export              | Signature                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `runFile`           | `(file, options?: RunFileOptions) => Promise<BenchResult>`; `RunFileOptions` = `RunOptions & { processes?, runtimes?, cwd?, samples? }` |
| `collectProvenance` | `(result, { cwd }) => Promise<BenchResult>`: versions, machine, flags, git revision, load.                                              |
| `createSizeRunner`  | `({ cwd }) => SizeRunner`                                                                                                               |
| `writeReadme`       | `(path, markdown) => void`; throws on missing, duplicated or reversed markers.                                                          |
| `checkReadme`       | `(path, result) => { upToDate, reason? }`                                                                                               |

`RunOptions`: `profile`, `filter` (substring or RegExp on group or case ids), `seed`, `timeoutMs` (async cases, default 10 000), `onProgress`, `sizeRunner`, `process` (process index when a host runs several; default 0), `budget` (a partial `Budget` that overrides the profile's).

## Result schema

`BenchResult` (schema 1) is plain JSON:

- `suite` — id, title, intro, notes, and `specHash` (the declared data only: ids, kinds, contracts, inputs, flags and options; never function source, so the hash is the same on every runtime).
- `profile`, `seed`, `publishable`, `warnings` (`{ code, message, group?, case?, runtime? }`).
- `environment` — runtime and version, OS, arch, CPU, cores, runtime flags, harness and mitata versions, git revision and dirty state, load at start and end, date.
- `packages` — the installed version of every package a case names.
- `groups[]` — kind, id, title, unit, contract, contract check (inputs, failures), baseline, `deterministic` (metrics), the empty-function `floor` and its raw `floorBlocks` (speed), `cases[]` (key, label, package, role, `workHash`, summary with estimate, interval, median, min, max, p75, p99, cv, n; raw `blocks` unless `--no-samples`; size bytes; limit; flags) and `comparisons[]` (ratio, interval, verdict: `lower`, `higher`, `tie` or `inconclusive`; with fewer than 2 blocks on a side the interval is `[ratio, ratio]`, meaning not measured, and the verdict `inconclusive`).
- `blocks` — speed cases: `{ process, block, ns, ops }`, time spent on that many operations. Metric cases reuse the shape for raw observations: one block per collected value, `ns` holding the value in the group's unit and `ops` = 1.
- `runtimes[]` — one full result per runtime in a matrix run.

The schema number changes when a field changes meaning. `report` and `compare` refuse results with another schema.

## How it measures

mitata does the timing: its `measure()` generates a timed loop per benchmark, batches very fast calls, drops outlier samples and keeps results in its `do_not_optimize` sink. `@arki/bench` adds what a published comparison needs:

1. **Contract check** before timing; a failed group is not timed.
2. **One timed function per case**, so no case benefits from running first at a shared call site.
3. **Untimed setup**, states prepared once, inputs cycled during timing.
4. **Time-based warm-up**, then **interleaved randomized blocks** with a recorded seed.
5. **An empty-function floor** measured like a case, to catch work that was optimized away.
6. **Fresh processes** for `publish`, merged with a two-stage bootstrap into one interval.
7. **Provenance**: versions, runtime flags, git revision, CPU and load go into every result.

## When to use something else

- **Instruction counts in CI** — [CodSpeed](https://codspeed.io) runs benchmarks under simulation, so results do not depend on the runner's noise. Use it when shared-runner timings are too noisy for your thresholds.
- **Whole commands** (CLI startup, builds) — [hyperfine](https://github.com/sharkdp/hyperfine) measures processes, with warm-ups and preparation commands.
- **History across commits** — [Bencher](https://bencher.dev) stores results over time and alerts on trends. `arki-bench` compares two runs; it keeps no history.
- **A quick loop in a test file** — `vitest bench` or plain mitata, when you do not need contracts, provenance or a README table.

## License

MIT
