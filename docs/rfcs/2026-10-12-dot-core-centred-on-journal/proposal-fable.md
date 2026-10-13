# A simpler core for Arki, centred on the journal — proposal (Fable)

Date: 2026-10-12. Read-only analysis of the working tree. Every claim about code has a `file:line`. Paths are relative to the repo root. Anything I did not open myself is marked "not verified".

## 1. Verdict in ten lines

1. The journal is the right centre of Dot. It is small, typed, transactional, and already has the one durable mechanism a Dot app needs: an event row plus a job row in the same transaction (`packages/journal/src/write.ts:148-255`).
2. Dot's core has two layers. The kernel (`@arki/dot`) stays dependency-light: plugin contract, lifecycle, hooks helper, zero-dep log. Six core plugins ship with Dot, are versioned and tested with it, and are what every Dot app gets: `log()`, `db()`, `journal()`, `schedule()`, `telemetry()`, and rpc through `http()`'s oRPC mount. Only one app boots through Dot today (novelette); the template does not (`turbo/generators/templates/application/server/src/index.ts:29-120`), so the template becomes the first Dot app.
3. The kernel package itself must not depend on Postgres or Redis. novelette-server boots with no database (`apps/novelette/server/src/app.ts:20-25`). The core plugins carry those dependencies; the kernel carries the contract they plug into.
4. One extension mechanism: a typed `around` hook (observe, change, veto, replace) with the same shape for async operations and sync log records. About 80 lines, zero deps.
5. Not everything becomes an event. Only facts about an entity are journal events. Commands, rpc calls, cron ticks, log lines and spans are *signals* that flow through hooks in memory. They are never written to Postgres by the framework.
6. The journal's job table is the default "run later" lane for new apps. BullMQ stays optional for the few apps that need Redis-grade throughput.
7. `@arki/log` must stop reading `process.env` and building pino at import time (`packages/log/src/lib/config.ts:46-66,118`). This breaks the composition doctrine inside the Dot kernel itself (`packages/dot/src/kernel/app-instance.ts:8,195`). Plans 004/007/010 fix this; keep them.
8. Unify the four copies of "collect feature slices by token" into one typed helper. Today they cost 15 unsafe casts across four adapters.
9. Do not build `@arki/rpc`. oRPC is already in 29 apps, its router is a compile-time fold, and its middleware is the rpc hook.
10. The one thing I would not do: push commands, logs, spans or cron ticks through the journal. It would turn a clean entity log into an unbounded telemetry table and make every log line a Postgres write.

## 2. Current state

Adoption counts come from an import sweep over `apps/*` source files (47 app directories). Counts are "apps that import", not "apps that declare a dependency".

| Piece | Package | What it does | Depends on | Dot adapter | Apps using it | Overlaps with |
| --- | --- | --- | --- | --- | --- | --- |
| Kernel | `@arki/dot` 0.4.1, 11k lines | Plugins with typed `needs`/`provides`, 5 hooks, manifest, diagnostics, CLI | `@arki/log`, `@opentelemetry/api`, zod, assert, contracts | is the kernel | **1 true boot**: novelette (`apps/novelette/backend/src/app.ts:30`, `apps/novelette/server/src/app.ts:20`). kapodopera imports `plugin` but never calls `defineApp`. 14 apps declare it, 12 never import it | — |
| Features | `@arki/feature` 0.0.2 | `defineFeature`, folds for router/repos, slice contracts | type-only on `@arki/dot` | `plug`, `plugs`, `tokens` (`packages/feature/src/dot.ts`) | 2: novelette, lottomato | slice collection in queue/schedule/http/journal |
| Journal | `@arki/journal` 0.1.0, 7.6k lines (half tests) | Entity event log + inline projections + after-commit effects via a job table and a poll worker | drizzle-orm, zod, cuid2, `@arki/log` (debug only) | `journal()` + `journalHandlers()` (`packages/journal/src/dot.ts:201-243`) | 3: games-platform (13 files), kapodopera, everseek. `./dot` used by **0** apps; `./orpc` by games-platform | event-sourcing (replaces it); queue (second async lane) |
| Old ES | `@arki/event-sourcing` 0.2.3, 4.2k lines | Emmett-based deciders, process managers, own Postgres pool | emmett, emmett-postgresql, drizzle | `eventSourcing()` (`packages/event-sourcing/src/dot.ts`) | 1: kapodopera (50 files) | journal |
| Database | `@arki/db` 0.1.9 | Drizzle factory, pg + PGlite, env, migrate, ids; 14 subpath exports | drizzle, pg, postgres, pglite, t3 env | `db()` (`packages/db/src/dot.ts:115-203`) | not counted separately; every backend | — |
| Queues | `@arki/queue` 2.0.2, 10k lines | BullMQ jobs, flows, repeatable schedules, cron patterns, middleware, bull-board, `runtime-local` on pg-boss/PGlite | bullmq, ioredis, pg-boss, pglite, bull-board | `queueRuntime()` + `jobs()` (`packages/queue/src/dot.ts:313-448`) | 7 (novelette, games-platform, evervest, kapodopera, loonyjobs, movietracker, pidpadpod). `runtime-local`: 1 (loonyjobs) | schedule (crons twice); journal (jobs twice) |
| Crons | `@arki/schedule` 0.0.1, 1k lines | croner + `every` timers in process, optional KV lock, overlap guard | croner, `@arki/log/debug` | `schedule()` + `schedules()` (`packages/schedule/src/dot.ts:174-279`) | 1: novelette | queue's `schedule-builder.ts` (279 lines) + `cron-patterns.ts` (347 lines) |
| Logs | `@arki/log` 0.0.3, 771 lines | `Logger` class over pino; severity, attributes, batching, trace ids | pino, debug | none | 13 apps import; 19 declare | meter/otel (pino → OTLP bridge, `packages/meter/src/integrations/otel/node.ts:14-16`) |
| Telemetry | `@arki/meter` 0.1.1 | Browser analytics (Plausible, Clarity, OpenPanel, Sentry) **and** the Node OTel SDK bootstrap | 14 `@opentelemetry/*` packages, clarity-js, spotlight | none | otel: 3 apps (avocabo, dailycanvas, lottomato). Browser analytics: 15 apps. 38 apps declare it | dot kernel emits spans via the API (`packages/dot/src/kernel/otel.ts:38-65`) |
| RPC | none | Apps use `@orpc/server` directly | — | `@arki/http` has `rpcMount` (`packages/http/src/bundle.ts:94-114`, `engine.ts:77-115`); journal has `commandErrors()` (`packages/journal/src/orpc.ts:48-56`) | 29 apps on oRPC; 0 on tRPC | — |
| HTTP | `@arki/http` 0.0.4 | Hono inside, route contracts, bundles, SSE | hono, undici | `http()` (`packages/http/src/dot.ts:171-327`) | 2: novelette, pidpadpod | — |
| KV | `@arki/kv` 0.1.7 | ioredis/keyv, rate limits, `setIfNotExists` lock | ioredis, keyv | `kv()` (`packages/kv/src/dot.ts:86-111`) | 16 | — |

Dependency picture today (arrows mean "imports at runtime"):

```
apps ──► @orpc/server (29 apps, direct)
apps ──► @arki/journal ──► drizzle, zod, @arki/log/debug
                  └─(peer)─► @arki/dot/plugin        (dot.ts, used by 0 apps)
                  └─(peer)─► @orpc/server            (orpc.ts, used by 1 app)
@arki/dot ──► @arki/log ──► pino, process.env at import   <── doctrine break
          └─► @opentelemetry/api (no-op without SDK)
@arki/queue ──► bullmq, ioredis, pg-boss, pglite, bull-board, @arki/log
@arki/schedule ──► croner, @arki/log/debug
@arki/meter ──► 14 x @opentelemetry/* + clarity-js + spotlight (one package, two worlds)
@arki/db, kv, http, auth, env, feature, event-sourcing ──(peer)──► @arki/dot/plugin
```

Three things do not line up with the founder's picture of Dot:

- Dot is not where the apps are. One app boots through it. The template hand-wires BullMQ and `Bun.serve` with `console.log` (`turbo/generators/templates/application/server/src/index.ts:30-54,94`). The template also imports `@kapodopera/backend/jobs`, `@kapodopera/backend/db` and `@kapodopera/backend/queue` (`:16,18,20`) and declares `@kapodopera/backend` as a dependency (`server/package.json:25`). I did not run the generator, so I cannot say whether a rewrite step fixes those names (not verified). As written, every new app's server starts coupled to kapodopera.
- The journal is young: three apps, no app on its Dot adapter, and it is being migrated into right now (uncommitted changes in games-platform, everseek, kapodopera per `git status`).
- Logs and telemetry have no Dot shape at all, and the kernel's own logging dependency is the one piece that breaks the kernel's own rules.

## 3. What makes it complicated today

Ranked by how much it costs app authors and how often it will bite.

1. **Three "run later" systems and two cron systems.** The journal has a job table and worker (`packages/journal/src/worker.ts:47-146`). `@arki/queue` has BullMQ jobs plus its own repeatable schedules and a 347-line cron pattern catalogue (`packages/queue/src/schedule-builder.ts`, `cron-patterns.ts`, actions at `packages/queue/src/dot.ts:166-183`). `@arki/schedule` is a third timer with a KV lock (`packages/schedule/src/runtime.ts:92-241`). An author must pick, and the template picks BullMQ schedules (`turbo/generators/templates/application/server/src/index.ts:9,19`).

2. **Four copies of one pattern: collect feature slices by token.** `jobs()`/`featureRegistry` (`packages/queue/src/dot.ts:236-290`), `schedules()`/`collectFeatureSchedules` (`packages/schedule/src/dot.ts:156-172`), `journalHandlers()`/`collectHandlers` (`packages/journal/src/dot.ts:79-199`), and http's bundle/feature needs (`packages/http/src/dot.ts:171-327`). Each re-derives `needs` from tokens, each re-checks the slice shape by hand, and each ends in an erasure cast: 4 casts in queue, 4 in schedule, 4 in http, 3 in feature (`packages/queue/src/dot.ts:447`, `packages/schedule/src/dot.ts:278`, `packages/http/src/dot.ts:177-178,219,327`, `packages/feature/src/dot.ts:98-100`). `JsonValue`/`JsonObject` are re-declared locally in queue and schedule (`packages/queue/src/dot.ts:25-26`, `packages/schedule/src/dot.ts:10-11`) although the kernel exports them (`packages/dot/src/index.ts:65-66`). The "typing strength outranks generality" rule is being lost at exactly these seams.

3. **`@arki/log` observes the world at import.** `new Configuration()` runs at module load (`packages/log/src/lib/config.ts:118`), reads `DEBUG`, `LOG_LEVEL`, `NODE_ENV` (`:46-59`) and constructs pino (`:66`). The kernel imports `Logger` (`packages/dot/src/kernel/app-instance.ts:8`) and builds one per app (`:195`). So importing `@arki/dot` reads env, in direct conflict with `composition-doctrine.md:17-20`. It also pins the kernel to Node (pino). This is why log has no Dot adapter: there is nothing to boot, and the config is a global singleton you cannot override per app.

4. **No way to observe or change behaviour inside the core pieces.** The journal's only instrumentation is `debug()` calls (`packages/journal/src/debug.ts`). A schedule lock failure and a handler failure are logged at debug and counted (`packages/schedule/src/runtime.ts:115-123,144-151`); nobody can be told. The kernel's `DotLifecycleObserver` can watch but never alter (`packages/dot/src/lifecycle-observer.ts:75-86`). A plugin that wants to wrap every command, add a field to every log line, or stop a cron run has nowhere to attach. Queue is the one piece with a middleware chain (`packages/queue/src/types/middleware.ts`), and that chain is its own shape.

5. **Telemetry is split in the wrong place.** `@arki/meter` carries the browser analytics used by 15 apps and the Node OTel SDK used by 3 apps, with 14 OTel packages as regular dependencies. The server bootstrap is a side-effecting import that also installs signal handlers (`packages/meter/src/integrations/otel/register.ts:23-31`). The kernel emits spans via the API (`packages/dot/src/kernel/otel.ts:111-140,192-222`) and threads trace ids into the logger by mutation (`:138-140`). Nothing else in the stack emits a span: no journal command, write, job, or cron run.

6. **Dot's configuration bag is untyped.** `$config` is `Readonly<Record<string, unknown>>` (`packages/dot/src/plugin-contract.ts:301-302`). Adapter options are typed, but there is no shared idea of "defaults plus one override".

7. **Weight.** `@arki/dot` is 11k lines, 1,660 of them in one kernel file and about 2.5k in the CLI. `@arki/queue` is 10k lines with five heavy runtime dependencies. For one booting app and seven queue apps, that is a lot of surface to keep consistent.

## 4. Target structure

### Package list after the change

| Package | Change | Why |
| --- | --- | --- |
| `@arki/log` | **Rewrite core**: zero-dep `Logger` + `LogRecord` + sync processor chain + sinks. `@arki/log/node` holds the pino sink. Main entry resolves to the core (plans 007/010). | Kernel import purity; runs everywhere; per-app override instead of a global singleton. **Breaking**: `configuration` singleton, `rootLogger`, `setTraceContext`, `LogBatch` leave the main entry. |
| `@arki/ts` | **Add** `@arki/ts/hooks`: `createHook` (async) and `createSyncHook`. ~80 lines, zero deps. | The one extension mechanism (section 6). |
| `@arki/dot` | **Keep** kernel contract. Depend on the new zero-dep `@arki/log`. Export a typed `collectSlices` helper from `@arki/dot/plugin` (or `@arki/feature/dot`, see decision 1). Delete `$config` or type it (decision 4). Remove `registerRoute` (already deprecated, `plugin-contract.ts:341-342`). | Smaller, pure, and the four adapters lose their casts. **Breaking**: `$config` removal, `registerRoute` removal. |
| `@arki/journal` | **Centre.** Add `journal.hooks` (`command`, `write`, `job`). Keep `./pg`, `./dot`, `./orpc`. `journal.ts`, `write.ts`, `command.ts`, `worker.ts` gain one call each. | Observe/wrap/veto at the three places that matter. Not breaking. |
| `@arki/schedule` | **Keep**, add `runtime.hooks.run` around `run()`; report lock failure and handler failure through the hook outcome and a `warn` log (absorbs plan 009). Handler context gains nothing new; apps pass the bound command runner through `context`. | Crons become observable and stoppable. Not breaking. |
| `@arki/telemetry` | **New**, split out of `@arki/meter`. `.` = hooks → OTel API bridge (depends on `@opentelemetry/api` only). `./node` = the SDK bootstrap (today's `meter/otel/node.ts`). `./register` = today's `register.ts`. `./dot` = plugin that subscribes the bridge to `journal`, `schedule`, `log` it `needs`. | Server telemetry out of the browser package; spans for commands, writes, jobs, cron runs for free. **Breaking**: `@arki/meter/otel` and `@arki/meter/otel/register` move (3 apps). |
| `@arki/meter` | **Shrink** to browser analytics. Drop all `@opentelemetry/*` deps. | 15 apps keep working; their dependency tree halves. |
| `@arki/db` | **Keep.** No change to the data layer. | It is plain Drizzle. The journal is the only thing that gives a db write meaning. |
| `@arki/queue` | **Optional, slim.** Delete `schedule-builder.ts`, `cron-patterns.ts`, `runtime-local/`, pg-boss and PGlite deps. Keep BullMQ jobs, flows, middleware, `queueRuntime()`, bull-board. | Crons live in `@arki/schedule`; "run later without Redis" lives in the journal. **Breaking**: queue schedules (template, kapodopera, others not counted), `runtime-local` (loonyjobs). |
| `@arki/feature` | **Keep.** Slice contracts stay structural. | Already the right shape. |
| `@arki/http`, `@arki/kv`, `@arki/auth`, `@arki/env` | **Keep, optional.** http and the slice adapters use `collectSlices`. | — |
| `@arki/event-sourcing` | **Delete** after kapodopera moves (journal spec `packages/journal/docs/specs/2026-10-09-journal-design.md:5-7`, migration order `:485-502`). | Replaced. |
| `@arki/rpc` | **Not created.** | Section 9. |

### Dependency direction after the change

```
@arki/ts (hooks, lazy)            zero deps, every runtime
@arki/log (core)                  zero deps, every runtime        ──► @arki/log/node ──► pino
@arki/dot ──► @arki/ts, @arki/log, @opentelemetry/api, zod
@arki/journal ──► @arki/ts/hooks, @arki/log, drizzle, zod      (peer: @arki/dot, @orpc/server)
@arki/schedule ──► @arki/ts/hooks, @arki/log, croner           (peer: @arki/dot)
@arki/telemetry ──► @arki/ts/hooks, @opentelemetry/api         (peer: @arki/dot, @arki/journal, @arki/schedule as types)
         └─ ./node ──► @opentelemetry/sdk-node + exporters
@arki/queue (optional) ──► bullmq, ioredis, @arki/log          (peer: @arki/dot)
@arki/meter (browser only) ──► plausible/clarity/openpanel
```

Rules: arrows point down only. Nothing imports `@arki/dot` at runtime except `./dot` subpaths. The journal never imports schedule, queue or telemetry; they hook into it.

### What "core of Dot" means concretely

Dot is two layers.

**Layer 1, the kernel (`@arki/dot`).** Plugin contract, lifecycle, manifest, diagnostics, CLI, the hooks helper, the zero-dep log core. Depends on `@arki/ts`, `@arki/log` (core), `@opentelemetry/api`, zod. Nothing else. It must stay importable with no database and no Redis, because novelette-server boots that way (`apps/novelette/server/src/app.ts:20-25`: kv, queue, http, schedule only) and because `dot explain` must run from a bare checkout (`composition-doctrine.md:54-56`).

**Layer 2, the core plugins.** These are part of Dot: documented in `packages/dot/docs`, versioned in lock-step with the kernel, run in the kernel's stress suite, present in the template's `app.ts`, and checked by `dot doctor`. Each lives at `<package>/dot` so the kernel package keeps its small dependency list.

| Core plugin | Publishes | What a Dot app gets with zero config | How a plugin overrides it |
| --- | --- | --- | --- |
| `log()` from `@arki/log/dot` | `log: Logger` | JSON records at `info`; `LOG_LEVEL`/`DEBUG` read at boot | `log.processors.around(...)` to change or drop records; provide your own `log` to replace |
| `db({ relations })` from `@arki/db/dot` | `db` | node-postgres pool from `DB_URL`; PGlite with `driver: 'pglite'` | options; `rename` for a second database; provide your own `db` |
| `journal({ j, tables, features })` from `@arki/journal/dot` | `journal` | entity log, inline projections, worker on (1 s poll, 20 per batch, 8 attempts) | `journal.hooks.command/write/job`; `worker: false` to run the lane elsewhere; provide your own `journal` |
| `schedule({ features, context })` from `@arki/schedule/dot` | `schedule: ScheduleRuntime` | in-process crons and intervals, overlap skip, no lock | `schedule.hooks.run`; `lock: kv` for many replicas; provide your own |
| `telemetry()` from `@arki/telemetry/dot` | nothing (subscribes) | spans and metrics for lifecycle, commands, writes, jobs, cron runs, via the OTel API; no-op without an SDK | `./node` SDK at the process entry; replace the bridge plugin |
| rpc: `http({ features })` with `rpcMount` from `@arki/http/dot` + `commandErrors()` from `@arki/journal/orpc` | `httpServer` | the composed oRPC router mounted, journal errors mapped to oRPC codes | oRPC middleware; your own mount |

**Optional plugins**: `queue()`, `kv()`, `auth()`, `env()`, and anything an app writes. They follow the same contract but are not promised by Dot.

**Position: the core pieces stay usable without Dot.** Every core plugin wraps a plain factory (`initJournal`, `createScheduleRuntime`, `createLogger`, `startTelemetry`), and the plugin owns only boot order and teardown. I hold this position for two reasons. First, "if it does not need boot, it does not need a plugin" (`composition-doctrine.md:140`) is Dot's own rule, and the journal's definitions need no boot. Second, 46 of 47 apps do not boot through Dot today; letting them adopt the journal first and Dot second is the only migration path that does not stall. This is a choice, not a default: if the founder wants the factories private to the plugins, the design still holds, and stage 5 of the migration becomes "Dot first, journal second" for every app.

## 5. The event model

### What an event is

An event is a recorded fact about one entity: `journal_events` row with `kind`, `entity_id`, `version`, `type`, `data`, `meta`, `seq` (`packages/journal/src/pg.ts:24-41`). It is written by `journal.write` inside the caller's transaction, after the row is locked and the reducers have run (`packages/journal/src/write.ts:90-266`). Only entity facts are events. Nothing else is.

### One durable mechanism, one in-memory mechanism

| Mechanism | What flows | Where | Survives a crash | Ordered | Who consumes |
| --- | --- | --- | --- | --- | --- |
| Journal | entity events, effect jobs | Postgres, same transaction | yes | per entity by `version`; globally by `seq`; effects: no promise (spec `:385`) | projections (inline), effects (after commit), replay/verify/repair |
| Hooks | operation signals: command, write, job, cron run, log record, lifecycle | process memory | no | registration order = declaration order | telemetry, policy plugins, tests |

Two mechanisms are the minimum. A single durable one would put log lines in Postgres. A single in-memory one would lose the outbox guarantee the journal already gives.

### How each thing relates to the journal

| Thing | Is it an event? | Relation |
| --- | --- | --- |
| A db write via `journal.write` | **yes** | The write is the event. Reducers derive the row. |
| A db write via plain Drizzle | no | Not every table is an entity. Tables that need history become entities; the rest stay tables. The framework does not intercept Drizzle. |
| A command (`journal.run`) | no, it *produces* events | Unit of work. One transaction, parsed input and meta (`packages/journal/src/command.ts:38-87`). Passes through `hooks.command`. Not stored (the spec dropped the command bus, `:469-475`). |
| An rpc call | no | A transport that binds `meta` from the request and calls commands (`journal.bind`, `packages/journal/src/api.ts:147`). oRPC middleware is its hook. Errors map via `commandErrors()`. |
| A journal job (effect run) | no, it is the outbox | One row per effect per event, inserted in the write (`write.ts:247-255`); claimed with `SKIP LOCKED` and a lease (`worker.ts:64-95`); deleted on success; retried with backoff; dead after 8 attempts (`worker.ts:124-133`). Passes through `hooks.job`. |
| A BullMQ job | no | Optional transport an effect may enqueue into for heavy or rate-limited work. Keeps its own middleware. |
| A cron tick | no | An in-memory signal. The handler runs a command with system meta (`journal.bind(db, { actorId: 'system' })`). If the business must remember the run, the command writes an event. Passes through `schedule.hooks.run`. |
| A log line | no | A record through the sync processor chain, then sinks. Trace ids are stamped by the telemetry processor, not by mutating the logger. |
| A trace span | no | Produced by `@arki/telemetry` from `after` hooks on command, write, job and cron run, plus the kernel's lifecycle spans. Emitted to the OTel API only; no SDK means no-op. |
| A Dot lifecycle step | no | `DotLifecycleObserver` stays as the in-memory signal (`lifecycle-observer.ts:38-73`). The kernel does not gain `around` hooks (section 9). |

### Ordering, transactions, failure

- **Inside a command**: one transaction; nested `run` is a savepoint; every `write` and `run` must be awaited before the handler returns or the command fails (`command.ts:77-83`). Keep.
- **Projections** run inside the write's savepoint (`write.ts:239-245`). A projection error rolls the write back. Keep.
- **Effects** run after commit, at least once, in no promised order. Effects are idempotent on `jobId`. Keep.
- **Hooks around a command** run inside the one-at-a-time guard and around the transaction. A hook that throws before `next` vetoes: no transaction opens. A hook that throws after `next` resolved cannot undo the commit; the rule is "after the commit, hooks observe only". The hook runner enforces this by passing a frozen `outcome` to `after` observers and by catching and debug-logging their errors, as the kernel already does for observers (`app-instance.ts:283-290`).
- **Hooks around a job** wrap `effect.run` (`worker.ts:120`). Throwing counts as a failed attempt and follows the retry rules. Returning without calling `next` acknowledges the job: the wrapper takes responsibility.
- **Hooks around a cron run** wrap `run(schedule)` (`runtime.ts:126`). Returning `{ status: 'skipped-hook' }` without calling `next` stops the run. Lock and handler failures surface as the outcome.
- **Log processors** are sync, may return `null` to drop a record, and may never throw past the logger: a throwing processor is dropped from the chain for that record and reported once through the sink at `warn`.

## 6. The extension model

One shape: an `around` wrapper over an operation. Observe = `after`. Change = call `next` with a changed input or map the result. Veto = throw before `next`. Replace = return without calling `next`. The same shape exists for sync operations (log records). Proposed location `@arki/ts/hooks`.

```ts
// @arki/ts/hooks — zero deps, every runtime
export type Outcome<Out> = { readonly ok: true; readonly value: Out } | { readonly ok: false; readonly error: unknown };

export type Next<In, Out> = (input: In) => Promise<Out>;
export type Around<In, Out> = (input: In, next: Next<In, Out>) => Promise<Out>;
export type After<In, Out> = (input: In, outcome: Outcome<Out>) => void;

export type Hook<In, Out> = {
  /** Wrap the operation. First registered runs outermost. Returns an unsubscribe. */
  readonly around: (wrap: Around<In, Out>) => () => void;
  /** Observe the finished operation. Sync, cannot change it, errors are swallowed to debug. */
  readonly after: (observe: After<In, Out>) => () => void;
};

/** What the owning library gets: the public hook plus the runner it calls. */
export type HookPoint<In, Out> = {
  readonly hook: Hook<In, Out>;
  readonly run: (input: In, base: Next<In, Out>) => Promise<Out>;
};

export function createHook<In, Out>(name: string): HookPoint<In, Out> {
  const wraps: Around<In, Out>[] = [];
  const afters: After<In, Out>[] = [];
  const remove = <T>(list: T[], item: T) => () => {
    const at = list.indexOf(item);
    if (at >= 0) list.splice(at, 1);
  };
  const run: HookPoint<In, Out>['run'] = async (input, base) => {
    const chain = wraps.reduceRight<Next<In, Out>>((next, wrap) => value => wrap(value, next), base);
    let outcome: Outcome<Out>;
    try {
      outcome = { ok: true, value: await chain(input) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    for (const observe of afters) {
      try {
        observe(input, outcome);
      } catch {
        // observers never break the operation; the owning library debug-logs `name`
      }
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
  return {
    hook: {
      around: wrap => (wraps.push(wrap), remove(wraps, wrap)),
      after: observe => (afters.push(observe), remove(afters, observe)),
    },
    run,
  };
}

/** Same shape, sync. Used for log records, where a call must not await. */
export type SyncNext<In, Out> = (input: In) => Out;
export type SyncAround<In, Out> = (input: In, next: SyncNext<In, Out>) => Out;
export type SyncHook<In, Out> = { readonly around: (wrap: SyncAround<In, Out>) => () => void };
export function createSyncHook<In, Out>(name: string): { readonly hook: SyncHook<In, Out>; readonly run: (input: In, base: SyncNext<In, Out>) => Out };
```

Order is registration order, and registration happens in plugin `boot`, so order is declaration order — the same rule the kernel already has (`principles.md:85-86`).

### Hook points per core piece

| Piece | Hook | `In` | `Out` | Inserted at |
| --- | --- | --- | --- | --- |
| journal | `hooks.command` | `{ name: string; input: unknown; meta: MetaOut; depth: number }` | `unknown` | `packages/journal/src/command.ts:45`, around `oneAtATime(...)` |
| journal | `hooks.write` | `{ kind: string; id: string; meta: MetaOut }` | `{ events: readonly Recorded<string, unknown, MetaOut>[] }` | `packages/journal/src/write.ts:87` |
| journal | `hooks.job` | `{ effect: string; jobId: string; attempt: number; event: Recorded<string, unknown, MetaOut> }` | `void` | `packages/journal/src/worker.ts:120` |
| schedule | `hooks.run` | `{ name: string; cron?: string; every?: ScheduleInterval; firedAt: Date }` | `ScheduleRunResult` (gains `'skipped-hook'`) | `packages/schedule/src/runtime.ts:126` |
| log | `processors` (sync) | `LogRecord` | `LogRecord \| null` | the new `Logger` core, before sinks |
| dot | `DotLifecycleObserver` | existing | — | unchanged (`app-instance.ts:283-326`) |
| rpc | oRPC `os.middleware` | existing | — | unchanged |
| queue | its middleware chain | existing | — | unchanged |

`MetaOut` is the journal's own meta type, so a command hook is typed per journal: `journal.hooks.command.around(({ meta }, next) => ...)` sees `meta.actorId`. The erased parts (`input: unknown`, `Out: unknown`) are honest: a hook that spans every command cannot know one command's schema. A hook that needs the schema wraps that one command's handler in app code.

How a plugin reaches a hook: it `needs` the service and registers in `boot`. No global registry, no ambient context — the same rule as `principles.md:71-73`.

```ts
import { plugin, service } from '@arki/dot/plugin';
import type { Journal } from '@arki/journal';

export const auditCommands = plugin({
  name: 'audit-commands',
  needs: { journal: service<Journal<typeof meta, AppTx, Db>>(), log: service<Logger>() },
  boot({ journal, log }) {
    const off = journal.hooks.command.after(({ name, meta }, outcome) => {
      log.info('command', { name, actorId: meta.actorId, ok: outcome.ok });
    });
    return { auditOff: off };
  },
  dispose({ auditOff }) {
    auditOff();
  },
});
```

Replacing a whole piece needs no hook: a plugin that provides `journal` under the same wire key is the replacement, and the kernel's `needs` check keeps consumers honest (`define-app.ts:208-211`).

## 7. Configuration

Defaults that work with zero configuration:

| Piece | Zero-config behaviour |
| --- | --- |
| log | level `info`, JSON records to the Node sink in Node/Bun, to `console` elsewhere. `LOG_LEVEL` and `DEBUG` are read at `createLogger()` call time or by the `log()` plugin's boot, never at import. |
| db | `db({ relations })` reads `DB_URL` at boot (`packages/db/src/dot.ts:177`). Unchanged. |
| journal | `journal({ j, tables, features })`: worker on, `pollMs` 1000, `batchSize` 20, lease 60 s, 8 attempts, backoff doubling to 5 min (`worker.ts:18-22`). Unchanged. |
| schedule | in process, no lock, `overlap: 'skip'`, no jitter (`runtime.ts`, `index.ts:84,94`). Unchanged. |
| telemetry | no-op without `OTEL_EXPORTER_OTLP_ENDPOINT` (`packages/meter/src/integrations/otel/node.ts:71-75`). Unchanged. |

Overriding one thing without restating the rest:

1. **Options are partial with defaults merged inside the factory.** `journal({ j, tables, features, pollMs: 250 })` changes one number. Every adapter already works this way; make it the written rule and make every option field optional except the ones that cannot have a default (`relations`, `tables`).
2. **Env-derived values are thunks**, as the doctrine already says: `kv(() => ({ url: env.REDIS_URL }))` (`apps/novelette/backend/src/app.ts:34`). No new mechanism.
3. **Behaviour overrides are hooks**, registered by a plugin that `needs` the service. No option flags for behaviour.
4. **Replacements are plugins** that provide the same wire key. `rename` handles two instances.
5. **No global config bag.** `$config` (`plugin-contract.ts:301-302`) is `Record<string, unknown>`; a plugin reading it must cast. Delete it, or type it per app with a zod schema and derive `KernelCtx['$config']` from the schema (decision 4). I recommend deleting: every real override above has a typed home already.

## 8. What the app author writes

A small shop app on Dot: one `order` entity, one command, one effect (the job), one cron, one rpc procedure. "Before" is today's APIs as they exist in the tree. "After" is the same app on Dot's core plugins. Both would type-check under the rules; the "after" types are the ones defined in sections 6 and 7. The three plugins at the end show how a Dot plugin overrides a core piece.

### Before (today)

```ts
// backend/src/journal.ts
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { z } from 'zod';
import type { Db, Tx } from './db';

export const tables = journalTables();
export const meta = z.object({ actorId: z.string().min(1) });
export const j = initJournal.tx<Tx>().db<Db>().create({ meta });

// backend/src/features/orders/order.ts
import { z } from 'zod';
import { j } from '../../journal';
import { orders } from '../../schema';

export const OrderPlaced = j.event('OrderPlaced', z.object({ total: z.number().positive() }));
export const OrderPaid = j.event('OrderPaid', z.object({}));
export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' }));

export const payOrder = j.command('payOrder', z.object({ orderId: z.string() }), async (input, { write }) => {
  const { row } = await write(order, input.orderId, { events: row => (row?.status === 'placed' ? [OrderPaid({})] : []) });
  return row;
});

// the "job": an effect, run after commit by the journal worker
export const orderMail = j.effect('order-mail', order, {
  OrderPaid: async (event, { jobId }) => sendReceipt(event.entityId, jobId),
});

// backend/src/features/orders/index.ts
import { defineFeature } from '@arki/feature';
import { journalHandlers } from '@arki/journal/dot';
import { schedules } from '@arki/schedule/dot';
import { defineSchedule } from '@arki/schedule';
import { ordersRouter } from './router';
import { orderMail } from './order';

export const ordersFeature = defineFeature('orders', {
  router: { orders: ordersRouter },
  use: [
    journalHandlers({ effects: [orderMail] }),
    schedules([
      defineSchedule<{ db: Db }>({
        name: 'close-stale-orders',
        cron: '0 3 * * *',
        handler: async ({ db }) => closeStaleOrders(db),
      }),
    ]),
  ],
});

// backend/src/features/orders/router.ts (oRPC, as 29 apps do today)
import { os } from '@orpc/server';
import { commandErrors } from '@arki/journal/orpc';
import { payOrder } from './order';

export const ordersRouter = {
  pay: os.$context<{ run: CommandRunner<{ actorId: string }, Tx> }>()
    .use(commandErrors())
    .input(payOrder.input)
    .handler(({ input, context }) => context.run(payOrder, input)),
};

// backend/src/app.ts (as apps/novelette/backend/src/app.ts:30-45 does today)
import { defineApp } from '@arki/dot';
import { service } from '@arki/dot/plugin';
import { db } from '@arki/db/dot';
import { plugs, tokens } from '@arki/feature/dot';
import { journal } from '@arki/journal/dot';
import { schedule } from '@arki/schedule/dot';
import { http } from '@arki/http/dot';

export const app = defineApp('shop')
  .use(db({ relations }))
  .useAll(plugs(features))
  .use(journal({ j, tables, features: tokens(features) }))
  .use(schedule({ features: tokens(features), needs: { db: service<Db>() }, context: ({ db }) => ({ db }) }))
  .use(http({ port: () => env.PORT, features: tokens(features) }));
```

Observations on "before": the entity, command, effect and router are already good. The friction is in `app.ts` (three slice collectors, each with its own `needs`/`context` story), in the cron (no access to the command runner unless the app threads it through `context`), and in the fact that nothing here is observable.

### After

The feature file, the entity, the command, the effect and the router do not change. That is deliberate: the journal's authoring surface is right. What changes is the app file, the cron handler's context, and what you can attach.

```ts
// backend/src/app.ts
import { defineApp } from '@arki/dot';
import { db } from '@arki/db/dot';
import { plugs, tokens } from '@arki/feature/dot';
import { journal } from '@arki/journal/dot';
import { log } from '@arki/log/dot';
import { schedule } from '@arki/schedule/dot';
import { telemetry } from '@arki/telemetry/dot';
import { http } from '@arki/http/dot';

const slices = tokens(features);

export const app = defineApp('shop')
  .use(log())                                   // zero-dep core; reads LOG_LEVEL at boot, not at import
  .use(db({ relations }))
  .useAll(plugs(features))
  .use(journal({ j, tables, features: slices })) // publishes `journal`, runs the worker
  .use(schedule({ features: slices, context: ({ journal, db }) => ({ db, run: journal.bind(db, { actorId: 'system' }) }) }))
  .use(telemetry())                             // needs journal, schedule, log; hooks them into OTel; no SDK = no-op
  .use(http({ port: () => env.PORT, features: slices }));
```

```ts
// the cron, now able to run a command as the system actor
defineSchedule<{ db: Db; run: CommandRunner<{ actorId: string }, Tx> }>({
  name: 'close-stale-orders',
  cron: '0 3 * * *',
  handler: async ({ run }) => {
    await run(closeStaleOrders, {});
  },
});
```

`schedule({ context })` already exists (`packages/schedule/src/dot.ts:82`); the only new thing is that `journal` is a typed need you can destructure, because `collectSlices` derives the needs properly and the adapter no longer casts them away.

### Three plugins

```ts
// 1. Add a field to every log line
import { plugin, service } from '@arki/dot/plugin';
import type { Logger } from '@arki/log';

export const withRegion = (region: string) =>
  plugin({
    name: 'log-region',
    needs: { log: service<Logger>() },
    boot({ log }) {
      const off = log.processors.around((record, next) => next({ ...record, attributes: { ...record.attributes, region } }));
      return { logRegionOff: off };
    },
    dispose({ logRegionOff }) {
      logRegionOff();
    },
  });
```

```ts
// 2. Wrap every command: time it, refuse a blocked actor
import { plugin, service } from '@arki/dot/plugin';
import type { Journal } from '@arki/journal';
import type { Logger } from '@arki/log';
import { CommandError } from '@arki/journal';

type ShopJournal = Journal<typeof meta, Tx, Db>;

export const commandGuard = (blocked: ReadonlySet<string>) =>
  plugin({
    name: 'command-guard',
    needs: { journal: service<ShopJournal>(), log: service<Logger>() },
    boot({ journal, log }) {
      const off = journal.hooks.command.around(async (call, next) => {
        if (blocked.has(call.meta.actorId)) throw new CommandError('FORBIDDEN', `actor ${call.meta.actorId} is blocked`);
        const started = performance.now();
        try {
          return await next(call);
        } finally {
          log.debug('command', { name: call.name, ms: Math.round(performance.now() - started) });
        }
      });
      return { commandGuardOff: off };
    },
    dispose({ commandGuardOff }) {
      commandGuardOff();
    },
  });
```

```ts
// 3. Stop a cron run during a maintenance window
import { plugin, service } from '@arki/dot/plugin';
import type { ScheduleRuntime } from '@arki/schedule';

export const maintenanceWindow = (isOpen: () => boolean) =>
  plugin({
    name: 'maintenance-window',
    needs: { schedule: service<ScheduleRuntime>() },
    boot({ schedule }) {
      const off = schedule.hooks.run.around((tick, next) =>
        isOpen() ? Promise.resolve({ name: tick.name, status: 'skipped-hook' as const }) : next(tick),
      );
      return { maintenanceOff: off };
    },
    dispose({ maintenanceOff }) {
      maintenanceOff();
    },
  });
```

Two small changes make plugin 3 possible: the `schedule()` adapter publishes its runtime as a service (today it provides nothing, `packages/schedule/src/dot.ts:176`), and `ScheduleRunStatus` gains `'skipped-hook'`. `CommandError` with a code already exists (`packages/journal/src/errors.ts`, mapped by `orpc.ts:30-32`); whether `'FORBIDDEN'` is in `CommandErrorCode` today is not verified.

## 9. Where I say no

1. **"Everything should be event based."** No. Only entity facts are journal events. Making commands, cron ticks, log lines and spans into journal rows would write every log line to Postgres through a locked transaction (`write.ts:90-92`), fill `journal_events` with non-entity rows that have no `kind`/`version` meaning, and break replay (`history.ts` folds by entity). Cost of doing it anyway: a telemetry table that grows without bound, a write lane that competes with business writes, and a journal nobody can replay. The in-memory hooks give the same observability at zero storage cost.

2. **Putting db, journal, queue, schedule into the kernel package's own dependency list.** No. They are Dot's core as plugins, not as kernel imports. The kernel would otherwise require Drizzle and Postgres to import. novelette-server, which has no database, could not boot (`apps/novelette/server/src/app.ts:20-25`), and `dot explain` could not run from a bare checkout. Principle P5 (zero optional deps, `principles.md:132-135`) exists for this reason. Cost: every Dot app pays for Postgres whether it has one or not, and the kernel can no longer run in a browser or Deno test.

3. **An `@arki/rpc` package.** No. oRPC is in 29 apps, zero on tRPC. Its router must be a compile-time fold (`composition-doctrine.md:146-149`), it already has middleware, and `@arki/http` already mounts it. A wrapper would be a second surface to keep in sync with oRPC's release cadence. Cost: 29 migrations for no capability gain.

4. **Storing commands (a command log).** No, as the journal spec already decided (`:469-475`). The command hook gives auditing; `meta` on each event gives who did it. Cost of a command table: a second source of truth that drifts from the events.

5. **`around` hooks on the Dot lifecycle.** No. A wrapper over `boot` could change what a plugin provides, which breaks the compile-time `needs` guard (`define-app.ts:69-77`). Observers stay observe-only. Cost of adding it: the type system can no longer promise that `services.db` is a `Db`.

6. **Rewriting `@arki/queue` into the journal.** No. BullMQ gives Redis-grade throughput, flows and a board that the journal's poll worker is not meant to replace. Slim it, mark it optional, keep it. Cost of a rewrite: 10k lines and seven apps for a capability one or two of them need.

7. **A global configuration registry.** No. Typed options per adapter, thunks for env, hooks for behaviour and plugins for replacement cover every case in section 7 with types intact. Cost: a `Record<string, unknown>` bag that every reader casts, which is exactly what `$config` is today.

## 10. Migration

Each stage ships on its own and leaves every app working.

| Stage | What | Effort | Risk | Breaks for published consumers | Plans |
| --- | --- | --- | --- | --- | --- |
| 0 | Fix the template server entry: remove the `@kapodopera/backend` imports and dependency; make the template boot through Dot with the current adapters (db, journal, schedule, http). | S | low | none | — |
| 1 | `@arki/log` core: characterisation tests, zero-dep core with processor chain and sinks, `@arki/log/node` pino sink, main entry switch. Kernel imports the core. `expectImportPure` on `@arki/dot`. | L | medium (every server process logs) | `@arki/log` 1.0: `configuration`, `rootLogger`, `setTraceContext`, `LogBatch` leave the main entry; `createLogger` and the method names stay. | **004 keep, 007 keep, 010 keep and extend** with `processors` and the `log()` adapter. |
| 2 | `@arki/ts/hooks`. Journal gains `hooks.command/write/job` (three insertion points). Schedule gains `hooks.run`, publishes its runtime, reports lock and handler failures through the outcome and a `warn` log. | M | low (additive) | none; minor versions | **009 fold in**: its lock-error fix becomes the `after` outcome plus the warn log. The `@arki/resilience` half of 009 is unrelated and stays its own plan. |
| 3 | `collectSlices` in `@arki/dot/plugin`; queue, schedule, http, journal adapters use it; delete the local `JsonValue` copies and the 15 casts. Remove `registerRoute`. | M | low | `@arki/dot` 0.5: `registerRoute` gone (already announced at `plugin-contract.ts:341`). | — |
| 4 | `@arki/telemetry` split out of `@arki/meter`: `.`, `./node`, `./register`, `./dot`. Bridge subscribes to journal, schedule and log hooks. `@arki/meter` drops its OTel deps. | M | low (3 apps) | `@arki/meter/otel*` removed in `@arki/meter` 0.2; new `@arki/telemetry` 0.1. | — |
| 5 | Journal adoption follows the spec's order (`journal-design.md:485-502`): template, sudoku, games-platform (in progress), payments, kapodopera, the rest. Delete `@arki/event-sourcing` when kapodopera's 50 files are moved. | XL (mostly app work, already under way) | medium (kapodopera) | `@arki/event-sourcing` removed from npm. | — |
| 6 | Slim `@arki/queue`: delete schedule builder, cron patterns, `runtime-local`, pg-boss and PGlite deps. Apps on queue schedules move them to `@arki/schedule`; loonyjobs moves off `runtime-local` to the journal lane or real Redis. | M | medium | `@arki/queue` 3.0. | — |
| 7 | Decide on `$config` (decision 4) and ship it. | S | low | `@arki/dot` 0.5 or 1.0. | — |

Stages 1 to 4 are independent of app migration and can run in parallel with stage 5. Stage 6 waits for stage 2 (schedule must be the better cron first).

## 11. Decisions for the founder

1. **Where the hook helper lives.** A: `@arki/ts/hooks` (no new package; `@arki/ts` already holds `Lazy`/`resolveLazy`). B: new `@arki/hooks`. Trade-off: A adds a dependency edge from journal and schedule to `@arki/ts`; B adds a package to publish and version. **Recommend A.**

2. **Default "run later" lane for new apps.** A: journal jobs (Postgres, zero extra infra, at-least-once, no ordering, 1 s poll). B: BullMQ via `@arki/queue` (Redis required, ordering and rate limits, bull-board). Trade-off: A removes Redis from the default stack and makes the template boot with a database alone; B keeps today's template shape. **Recommend A**, with B documented as the step up.

3. **Telemetry package name and timing.** A: `@arki/telemetry` now, in stage 4. B: keep `@arki/meter/otel` and add the hook bridge there. Trade-off: A is a clean split but a rename for 3 apps; B avoids the rename but keeps 14 OTel deps in a browser-facing package used by 15 apps. **Recommend A.**

4. **`$config` on the kernel context.** A: delete it. B: type it per app from a zod schema passed to `defineApp`. Trade-off: A is simplest and every override has a typed home; B keeps an escape hatch some plugin may use (I found no app using `$config`; not exhaustively verified). **Recommend A**, after a grep confirms no adapter reads it.

5. **`@arki/event-sourcing` end date.** A: delete right after kapodopera migrates (spec order). B: keep both for one more quarter so kapodopera can move feature by feature. Trade-off: A removes a 4.2k-line package and the emmett deps sooner; B lowers the risk on the one app that has 50 files on it. **Recommend B** with a fixed date, because kapodopera is also mid-migration on payments, claims and follows right now (recent commits).

## 12. Not examined

- `packages/dot/docs/lifecycle.md`, the full bodies of the two long RFCs (feature pips, transport-agnostic actions), and journal spec sections 4, 5 and 9 (read only in digest form via a subagent).
- `packages/dot/src/cli/*` (2.5k lines) beyond its file list; `packages/dot/src/kernel/app-instance.ts` beyond its structure and the lines cited.
- `packages/journal/src/entity.ts`, `history.ts`, `storage.ts`, `fold.ts`, `errors.ts` beyond signatures; whether `'FORBIDDEN'` is a `CommandErrorCode` is not verified.
- `packages/queue/src/*` beyond `dot.ts`, `index.ts`, `init.ts` and `types/middleware.ts` outlines; the BullMQ job builder API in detail.
- `packages/http/src/*` beyond `dot.ts`, `engine.ts` and `bundle.ts` greps.
- `packages/auth`, `packages/env` beyond `dot.ts`, `packages/kv` beyond `dot.ts` and `setIfNotExists`.
- Whether any plugin reads `$config` (decision 4), and whether the template generator rewrites the `@kapodopera/backend` imports in `turbo/generators/templates/application/server/src/index.ts`.
- Import counts cover `.ts/.tsx/.mts` only; `.js/.mjs` configs were not scanned. The browser-analytics count for `@arki/meter` is a regex over subpaths and may overcount by one (avocabo).
- The uncommitted working-tree changes in games-platform, everseek and kapodopera were not read; I used the committed journal package plus its current `src/`.
