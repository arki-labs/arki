AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/clock

The one place code asks "what time is it?" and "wake me later". Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, `src/index.ts` and `src/clock.ts` win.

## Laws

1. Library and app code takes a `Clock` as an argument. It never calls `new Date()`, `Date.now()` or `setTimeout` for logic that tests need to control.
2. The default is `SystemClock`. A test passes `MockClock`. There is no global clock and no way to install one.
3. Time moves forward on purpose only. `MockClock.advance` and `advanceAsync` reject negative and non-finite steps with `ARKI_CLOCK_E001`. `setNow` is the only way back, and it fires no timers.
4. A delay must be finite, zero or more, and at most `MAX_TIMER_MS`. Anything else throws `ARKI_CLOCK_E002` at once, on every clock. A mock never accepts what a real clock refuses.
5. `now()` returns a fresh `Date` each call. No caller can change the clock by changing the value it got.
6. An aborted `sleep` returns `SleepCancelled` with private `cause` set to `signal.reason`. The timer is cleared first.
7. The package depends only on portable `@arki/failure` and no `node:*` import. It uses `Date` and `setTimeout` only at call time, so it runs on every engine.
8. Static setup misuse throws `ClockError`; operational sleep cancellation returns the canonical `SLEEP_FAILURES` outcome. Match definitions or codes, never messages.
9. Never write benchmark numbers by hand. `bun run bench --write-readme` writes them from an idle machine.

## Changing this package

1. Change `src/clock.ts` or `src/errors.ts`. Keep the JSDoc on every error code: summary, `@fix`, `@verify`.
2. Add the case to `src/clock.test.ts`. Pin the boundary that decides the behaviour, such as a delay of exactly `MAX_TIMER_MS`.
3. Keep `MockClock` and `SystemClock` equal on every rule above. A rule that only the mock enforces hides bugs until production.
4. Add a changeset in `.changeset/`. Documentation-only changes use `patch` and the line `no demo impact: documentation and doc-example changes only, runtime behaviour unchanged`.

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
