AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/queue

## Laws

1. A job can run more than once, on every lane. A handler passes `ctx.job.id` to each external system as its idempotency key.
2. An expected refusal is a returned `@arki/failure` value, never a throw. A throw is a defect and is not retried by default.
3. Retry lives in one option: `.options({ retry })`, a `Backoff` from `@arki/resilience`. Never pass `attempts` or `backoff` through `bullmqOptions`.
4. `trigger()` and `enqueue()` return an id or a `JobTriggerFailure`. Never use the id before the check. After `QueueAcceptanceUnknown`, look for the job by its key before sending it again.
5. A job name is its queue name. Use dots, never a colon. Version it (`mail.welcome.v1`) so a rename is deliberate.
6. `runAfter` and `runAt` take the caller's transaction, never the root database (`OUTBOX_E001`).
7. Outbox args are plain JSON. Validation of stored args uses the job's own input schema.
8. Every input check goes through a Standard Schema. Never hand-write a guard on a job's input.
9. Middleware calls `next()` once. It returns a refusal directly and never substitutes `next().output`.
10. A flow is a tree. A step has at most one dependent (`ARKI_QUEUE_E017`).
11. `@arki/queue/outbox` imports no BullMQ, Redis or pg-boss at runtime.
12. Telemetry never changes a delivery outcome. A span failure is swallowed.
13. Library code logs with `getLogger('arki:queue...')`, never `console`. Lifecycle logs are `debug`.

## Changing this package

- New error: add the code to the right table in `src/errors.ts`, `src/outbox/errors.ts` or `src/foreman/errors.ts`, with JSDoc `@fix` and `@verify`. Update the guide's Errors section.
- New entry point: add the export to `package.json`, then run `bun ../../tooling/library/src/llms.ts --write`.
- Change that touches the lanes: run the shared tests in `src/job-conformance.spec.ts`. They need Docker for Redis.
- Keep `README.md`, `llms.txt`, `docs/agent-guide.md` and `docs/recipes/recover-jobs.md` in step. The recipe's code is `examples/recover-jobs.ts`.
- Update `CHANGELOG.md` through a changeset, not by hand.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
