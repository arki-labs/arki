# @arki/bench agent guide

Read `llms.txt` first for the map. When this guide and `AGENTS.md` disagree, `AGENTS.md` wins.

## The model

1. A suite is a list of groups. A `compare` group ranks cases that do the same work. A `scenario` shows different work side by side. A `size` group measures a bundle. A `metric` group records any number.
2. A contract states in words what every ranked case returns. The engine checks it on every input before timing.
3. A run returns a `BenchResult`. It carries the numbers, the intervals, the provenance and `publishable`.
4. Only a `publish` profile run can be publishable. `quick` and `explore` are for development.
5. The README table is generated from a saved result. It is never typed by hand.

## Task map

### Add a benchmark for a library

1. Create `bench/<name>.bench.ts` and export a `defineSuite(...)` default.
2. Write a `compare` group: an `id`, a `contract`, `inputs`, an `expected` function, a `baseline` and the `cases`.
3. Run `arki-bench` (explore profile) and read the table.
4. Fix any contract failure before you read a timing.

```ts
import { compare, defineSuite } from '@arki/bench';

export default defineSuite({
  id: 'my-lib',
  groups: [
    compare({
      id: 'double',
      title: 'Double a number',
      contract: { id: 'double/v1', description: 'twice the input' },
      inputs: [1, 2, -3],
      expected: (x: number) => x * 2,
      baseline: 'multiply',
      cases: { multiply: { run: (x: number) => x * 2 }, add: { run: (x: number) => x + x } },
    }),
  ],
});
```

### Publish numbers in the README

1. Put the `<!-- bench:start -->` and `<!-- bench:end -->` markers in the README.
2. On an idle machine run `arki-bench --profile publish --write-readme`.
3. Run `arki-bench check` in CI. It fails when the section is stale.

### Gate a pull request

1. Save a base result and a head result with the same profile.
2. Run `arki-bench compare base.json head.json --ci`.
3. Read `regressed`, `improved`, `inconclusive` and `incompatible` rows.

## Rules that bite

- `run` must return its result. The result goes to the sink so the work is not optimized away.
- `setup` is synchronous and untimed. Open async resources at module load.
- A case that mutates its input gets a blocking `state-mutated` warning.
- Rough results (`quick`, `explore`) are never written to a README without `--force`.
- Ratios compare libraries within one runtime. Columns for different runtimes are not comparable.

## Errors

| Error or warning        | Meaning                                        | What to do                         |
| ----------------------- | ---------------------------------------------- | ---------------------------------- |
| `SpecError`             | The suite is invalid; `problems` lists all     | Fix every listed problem           |
| contract check failure  | Two cases returned different results           | Fix the case, or declare `differs` |
| `state-mutated`         | A timed `run` changed its input                | Build fresh state in `setup`       |
| `unstable`              | The spread is above the profile limit          | Re-run on a quiet machine          |
| `runtime-missing`       | A requested runtime or Node path was not found | Install it or fix the path         |
| `node-version-mismatch` | The Node that ran is not the project's target  | Use `--node <path>`                |

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
```
