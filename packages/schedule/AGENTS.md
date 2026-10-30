AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/schedule

## Laws

1. A schedule is a name, a timing (`cron` or `every`) and a handler. The name is unique in an app (`ARKI_SCHEDULE_E002`) and has no surrounding spaces.
2. A handler returns a value or a declared `@arki/failure` refusal. A refusal is `refused`, never `ran`. A throw is `handler-failed`.
3. The runtime never retries a handler. A retry is the caller's or the durable backend's job.
4. An in-process schedule skips a tick that falls due while the app is down. Only `durable: true` catches up, and then as one run.
5. Durable delivery is at least once. A handler with an external effect passes its own idempotency key.
6. A durable name has no `:`, because BullMQ forbids it in a queue name (`ARKI_SCHEDULE_E001`).
7. With several replicas, an in-process schedule needs a `lock`. Without one every replica runs every tick.
8. This package imports no queue or lock runtime. `durable` and `lock` are structural ports; lock outcome types come from their canonical definitions. `@arki/queue` and `@arki/lock` plug in.
9. The main entry stays free of timers and the logger. The runtime lives in `@arki/schedule/runtime`.
10. Telemetry never replaces a run result and never runs a handler twice. Spans carry no payloads, lock keys or private causes.
11. A new error code goes in `src/errors.ts` with JSDoc `@fix` and `@verify`.

## Changing this package

- New entry point: add the export to `package.json`, then run `bun ../../tooling/library/src/llms.ts --write`.
- New run status: change `ScheduleRunResult` in `src/runtime.ts`, then `src/orpc.ts`, the README Failure behaviour table and `docs/reference/results.md`.
- Keep `README.md`, `llms.txt`, `docs/agent-guide.md` and `docs/recipes/run-schedules.md` in step. The recipe's code is `examples/run-schedules.ts`.
- Change the changelog through a changeset, not by hand.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
