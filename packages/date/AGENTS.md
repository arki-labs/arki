AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/date

Date and time math on Temporal values, with one arithmetic policy. Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. Values are Temporal's own types: `PlainDate`, `PlainDateTime`, `ZonedDateTime`, `Instant`, `Duration`. The package adds no parallel classes. The only shape it adds is `Interval<T> = { start, end }`.
2. No hidden now. Time comes from an `@arki/clock` `Clock` that the caller passes. Never call `Date.now()` or `new Date()` for logic in `src/`.
3. No hidden zone. A zone-less string is never guessed into a zone. Functions that need a zone take it as an argument. `systemTimeZone()` is the only door to the runtime zone, and it says so.
4. Overflow clamps by default and `{ overflow: 'reject' }` throws. Every function that does arithmetic follows that one rule.
5. Calendar units move the wall clock and exact units move the instant. `diff` counts calendar units and `diffElapsed` counts exact time. A function states which.
6. Intervals are half-open: `[start, end)`. Touching intervals do not overlap. `union` never bridges a gap.
7. Iteration is lazy and bounded. More than `maxItems` throws. Nothing truncates silently.
8. Invalid input throws `RangeError`. Mixed kinds throw `TypeError`. The `try*` functions return `undefined` and are the only non-throwing doors.
9. The default locale is `en-US`, so a server and a client render the same text. A caller passes its own locale.
10. The runtime floor is `ECMAScript` plus `Intl`. `temporal-polyfill` supplies `Temporal` where the engine has none. No `node:*` import in portable entries.
11. The optional subpaths (`zod`, `react`, `orpc`, `tanstack`) keep their peers optional and are not re-exported from the root.
12. The token formatter and `parseISO` stay differential-tested against date-fns. A change to either needs a new row in the comparison.
13. Never write benchmark numbers by hand. `bun run bench --write-readme` writes them from an idle machine. A run on a busy machine prints "Not publishable" and nobody quotes it.

## Changing this package

1. Pick the module (`src/math.ts`, `src/business.ts`, and so on). One concern per module, one subpath per module.
2. Write the test first, next to the module. Pin the DST edge, the month-end clamp and the zone, not only the happy path.
3. Keep `README.md` truthful. Behaviour claims in the Policies section need a test.
4. A new module needs an `exports` key in `package.json`, a top JSDoc line and a run of `bun ../../tooling/library/src/llms.ts --write`.
5. Update `examples/delivery-estimate.ts` only with its test. The README mirrors its region, so run `arki-doc-examples --write` after an edit.
6. Add a changeset in `.changeset/`. Documentation-only changes use `patch` and the line `no demo impact: documentation and doc-example changes only, runtime behaviour unchanged`.

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run test:bun
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
