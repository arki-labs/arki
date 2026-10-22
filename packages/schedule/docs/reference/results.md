# Run results and observation

Reference for `ScheduleRunResult`, handling business outcomes, and telemetry.

## Run results

Each run reports a `ScheduleRunResult` with one status:

| Status            | Meaning                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ran`             | The handler succeeded. `value` excludes defined failures.                                                                                                                                                                       |
| `refused`         | The handler returned a declared business failure. `failure` preserves its exact type, identity and data. Counted in `handlerFailures`; never reported as `ran`.                                                                 |
| `handler-failed`  | The handler threw or returned `UnexpectedDefect`. `cause` is the canonical `UnexpectedDefect`, with the original thrown value kept privately. Counted in `handlerFailures`.                                                     |
| `skipped-overlap` | `overlap: 'skip'` and a run of the same schedule is active in this process.                                                                                                                                                     |
| `skipped-lock`    | In process only: another replica holds the lock for this tick. Counted in `lockContention`.                                                                                                                                     |
| `lock-failed`     | The lock provider failed. Known `store`/`lost` codes become `ScheduleLockFailed` with bounded `data.lockCode`; other throws become `UnexpectedDefect`. Original causes stay private. Counted in `lockFailures` (or `lockLost`). |
| `unavailable`     | The runtime was already stopped; nothing ran.                                                                                                                                                                                   |

The durable adapter receives the same outcomes. Refusals, handler defects and
lock failures must be recorded as failed business execution; successful message
delivery alone does not make a schedule successful. Skips and unavailable runs
are separate scheduling decisions. The schedule runtime does not retry handlers.

## Steps and arounds

`with: [...]` on `defineSchedule` lists plain functions that run before the handler, in order. A step
`(ctx) => object | Failure` adds the keys it returns to the context of what follows. An around
`(ctx, next) => Promise<T>` wraps everything after it and the handler.

- A step that returns a failure refuses the run. The handler does not run and the result is `refused`, with that
  failure, as if the handler had returned it. It is counted in `handlerFailures`.
- Inside an around, a refusal is the value `next()` resolves to. A thrown error rejects `next()`.
- A step and an around are told apart by `fn.length >= 2`. Declare `next` as a plain second parameter: no default
  value, no rest parameter. Otherwise the around runs as a step.

The model is shared by every transport: [Steps and arounds](../../../dot/docs/middleware.md).

## Upgrade: typed business outcomes

Handle `refused` in an exhaustive status switch and read `outcome.failure`.
Read `outcome.cause.cause` only for private diagnostics when handling a defect;
serializing the canonical failure omits that private cause. Custom durable
adapters must preserve the failure envelope and mark its execution failed.
`cronRouterFor` sends domain refusals through the existing explicit `respond`
mapping, or through `failed` when no mapping exists. It never defaults a refusal
to an HTTP success. `UnexpectedDefect` uses `failed` directly.

`defineSchedule(...)`, `initSchedule.context<Ctx>().create().define(...)`, the
runtime's definition tuple and `composeSchedules(...)` retain each handler's
success and refusal types. Prefer the context builder over
`defineSchedule<Ctx>(...)`: supplying only the first generic argument prevents
TypeScript from inferring the remaining arguments. Avoid annotating a concrete
definition as the erased `ScheduleDef<Ctx>` when its result type is needed.
`ScheduleValueOf` remains the complete declared handler return for explicit cron
responders; `ScheduleSuccessOf` and `ScheduleFailureOf` infer its separate parts.
`schedules([definitions])` now retains the same declaration information as the
feature-owned forms. Schedule names reject surrounding whitespace so the typed
name is the actual registered name.

## Observation

Each scheduling attempt creates one `schedule.run` OpenTelemetry span, inherits
the active context and records its classified outcome and duration. No SDK or
exporter is installed by this library. Attributes include the declared schedule
name and outcome; handler payloads, lock keys and private error causes are absent.
Metric dimensions contain only the bounded scheduling outcome. Handler code can
use the standard active span for custom events. Observer failures, including a
context manager failing after invoking its callback, never replace the result or
run the handler twice. Scheduling skips retain their own outcome attributes.

The package-wide T08 audit still owns the remaining public declaration/lifecycle
error inventory. Durable trace propagation across persisted jobs belongs to the
queue adapter; an in-process execution span alone does not prove transport
propagation or durable recovery. The existing runtime `start()` API starts durable
registration asynchronously; its logs do not prove registration readiness.
