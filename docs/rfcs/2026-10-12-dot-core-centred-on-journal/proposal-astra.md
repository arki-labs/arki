## 1. Verdict in ten lines

1. Make Journal the standard path for business changes and their durable follow-up work.
2. Keep Dot responsible for composition, resource ownership, startup, and shutdown.
3. Add a thin `@arki/app` preset that assembles the existing adapters.
4. Keep database reads and ordinary infrastructure operations as direct calls.
5. Keep Journal effects for work caused by committed business events.
6. Keep BullMQ optional for independent jobs, long tasks, and workflows.
7. Separate server telemetry from browser analytics, and make logging import-pure.
8. Let plugins extend typed operations and replace explicitly selected providers.
9. I would not put commands, logs, traces, database queries, and cron ticks on one event bus.
10. **Category: clean & elegant**, provided the preset removes assembly code without introducing another execution engine.

## 2. Current state

This review reads the working tree on 2026-10-12.
No source files were changed.
No proposal or synthesis files were read.

The counts below deduplicate by `apps/{name}`.
“Imports” includes production source imports, type imports, and package subpaths.
It excludes tests, fixtures, stories, UI mockups, dependencies, and build output.
“Manifests” includes dependencies declared in any application workspace.
Neither measure proves deployed use.

| Piece | Apps: imports / manifests | Current responsibility, dependencies, and Dot integration |
|---|---:|---|
| Dot | **2 / 14** | Typed plugin composition and lifecycle. Depends on assert, contracts, log, Zod, and the OpenTelemetry API. Providers must precede consumers. `packages/dot/package.json:81`; `packages/dot/src/define-app.ts:203`. |
| Feature | **2 / 2** | Static router and repository composition, plus adapter-owned feature slices. Its root uses Dot types; `./dot` turns features into plugins. `packages/feature/src/index.ts:24`; `packages/feature/src/dot.ts:76`. |
| Journal | **3 / 3** | Commands, entity history, current rows, transactional projections, and durable effect jobs. Depends on Drizzle, Zod, IDs, and log. Dot and oRPC are optional peers. Its Dot adapter publishes the journal and starts a worker. `packages/journal/package.json:75`; `packages/journal/src/dot.ts:201`. |
| Older event sourcing | **1 / 1** | Emmett integration and message dispatch. Its projection bridge receives a separately captured Drizzle database. Its Dot adapter exposes lifecycle hooks. `packages/event-sourcing/package.json:106`; `packages/event-sourcing/src/store.ts:122`; `packages/event-sourcing/src/dot.ts:304`. |
| Database | **24 / 24** | Drizzle handles, drivers, configuration, and utilities. Installs pg, postgres, and PGlite. Dot opens and closes the selected database. The default pg adapter reads `DB_URL`; it has no explicit URL option. `packages/db/package.json:130`; `packages/db/src/dot.ts:86`; `packages/db/src/dot.ts:172`. |
| Queue | **7 / 6** | Jobs, schedules, flows, and workers. Installs BullMQ, Redis, pg-boss, PGlite, and Bull Board dependencies. Dot collects feature registries and starts workers. `packages/queue/package.json:49`; `packages/queue/src/dot.ts:340`. |
| Schedule | **1 / 1** | Croner and process timers, with optional external locking. Dot collects schedule slices and supplies execution context. It has no durable occurrence ledger. `packages/schedule/src/index.ts:62`; `packages/schedule/src/runtime.ts:104`; `packages/schedule/src/dot.ts:104`. |
| KV | **16 / 24** | Redis-backed storage, rate limiting, and related facilities. Creates Keyv Redis and ioredis clients. Dot resolves lazy configuration during boot. `packages/kv/src/index.ts:29`; `packages/kv/src/index.ts:56`; `packages/kv/src/dot.ts:86`. |
| HTTP | **2 / 2** | Route contracts, request context, foreign RPC mounts, and a Hono engine. Dot owns listening and draining. `packages/http/package.json:79`; `packages/http/src/dot.ts:21`; `packages/http/src/engine.ts:97`. |
| RPC | **29 / 29** | Apps use `@orpc/server` directly. HTTP supplies a mount boundary. Journal supplies command-error translation. `apps/arki/backend/src/api.ts:1`; `packages/http/src/bundle.ts:114`; `packages/journal/src/orpc.ts:29`. |
| Log | **13 / 19** | Shared Pino configuration and logger instances. Depends on Pino and debug. Configuration reads the environment and constructs Pino during import. There is no exported Dot adapter. `packages/log/package.json:29`; `packages/log/package.json:63`; `packages/log/src/lib/config.ts:45`; `packages/log/src/lib/config.ts:118`. |
| Meter | **17 / 37** | Browser analytics and server OpenTelemetry initialization. Installs both browser integrations and Node SDK dependencies. Its exported entries include no Dot adapter. `packages/meter/package.json:27`; `packages/meter/package.json:65`. |

Representative manifest anchors for the census are `apps/evervest/backend/package.json:40`, `apps/everseek/backend/package.json:50`, `apps/kapodopera/backend/package.json:88`, `apps/lottomato/backend/package.json:36`, and `apps/movietracker/server/package.json:19`.

The important adoption distinctions are:

- **Dot:** Novelette has a verified executable startup through `serverApp.start()`. Kapodopera’s imports include feature plugin declarations. Novelette also retains a separate lazy runtime for embedded consumers. Do not count its entire backend as exclusively Dot-owned. `apps/novelette/server/src/index.ts:23`; `apps/kapodopera/backend/src/features/cinema/content/plugin.ts:1`; `apps/novelette/backend/src/runtime.ts:2`.
- **Journal:** Everseek, Games Platform, and Kapodopera import it. Games Platform starts an effect worker in its Start server. Everseek and Kapodopera explicitly document having no worker at present. `apps/games-platform/start/src/server.ts:22`; `apps/everseek/backend/src/journal.root.ts:7`; `apps/kapodopera/backend/src/journal.root.ts:10`.
- **Telemetry:** only Avocabo, Dailycanvas, and Lottomato import `otel/register`. Whether exporters are configured in deployed environments is **not verified**. Their entrypoints are `apps/avocabo/start/src/server.ts:3`, `apps/dailycanvas/start/src/entry-server.ts:3`, and `apps/lottomato/start/src/entry-server.ts:3`.
- **Template:** the backend uses lazy database construction and static feature composition. The worker still imports Kapodopera jobs and uses MovieTracker naming. `turbo/generators/templates/application/backend/src/db.ts:12`; `turbo/generators/templates/application/backend/src/api.ts:15`; `turbo/generators/templates/application/server/src/index.ts:16`; `turbo/generators/templates/application/server/src/index.ts:31`.

The current dependency picture is:

```text
Apps
 ├─ Dot ─────────────── log → Pino, debug
 │   └──────────────── OpenTelemetry API, contracts, assert, Zod
 ├─ Feature ────────── Dot types; Dot runtime through ./dot
 ├─ Journal ────────── Drizzle, Zod, IDs, log
 ├─ Database ───────── Drizzle, pg, postgres, PGlite, env, log
 ├─ Queue ──────────── BullMQ, Redis, pg-boss, PGlite, Bull Board
 ├─ Schedule ───────── Croner, log; optional locking capability
 ├─ KV ─────────────── Keyv Redis, ioredis, rate limiting
 ├─ HTTP ───────────── Hono, listener dependencies, log
 ├─ oRPC ───────────── mounted through HTTP or app-specific hosts
 ├─ Meter ──────────── Node telemetry SDKs + browser analytics
 └─ Event sourcing ─── Emmett + PostgreSQL integration
```

Dependency evidence is in each package’s `package.json` at the lines cited above.
The overlap is primarily in **assembly, projections, background execution, and lifecycle ownership**.

## 3. What makes it complicated today

**1. There are several ways to assemble the same application.**

Novelette has a Dot graph and an embedded runtime.
Games Platform owns Journal worker startup and shutdown directly.
The template has another manual worker assembly.
A new abstraction will fail if these paths continue growing independently.
Evidence: `apps/novelette/backend/src/app.ts:30`; `apps/novelette/backend/src/runtime.ts:12`; `apps/games-platform/start/src/server.ts:22`; `turbo/generators/templates/application/server/src/index.ts:35`.

**2. Import purity is a rule rather than a consistent property.**

Log reads environment variables and creates Pino at import.
Queue’s declaration builder reads `NODE_ENV` unless explicitly configured.
Schedule validates and throws while declarations are constructed.
Journal declaration helpers also throw.
Evidence: `packages/log/src/lib/config.ts:45`; `packages/queue/src/init.ts:62`; `packages/schedule/src/index.ts:62`; `packages/journal/src/event.ts:8`.

The doctrine itself conflicts.
It forbids declaration-time throws, then requires duplicate-key rejection at module load.
I choose this brief’s explicit no-throw rule.
Keep compile-time rejection where possible.
Collect remaining declaration errors for explicit validation and boot rejection.
Evidence: `packages/dot/docs/composition-doctrine.md:17`; `packages/dot/docs/composition-doctrine.md:94`; `packages/feature/src/index.ts:145`.

**3. Similar-looking background mechanisms promise different things.**

Journal effects are transactional follow-up work.
BullMQ provides independent jobs and workflows.
Croner provides process-local timing.
The local queue adapter presents the same interface while lacking flows, interval schedules, and a complete BullMQ job object.
Evidence: `packages/journal/src/write.ts:247`; `packages/queue/src/index.ts:40`; `packages/schedule/src/runtime.ts:178`; `packages/queue/src/runtime-local/create-queue.ts:7`.

That last abstraction is misleading.
The public job context promises a full BullMQ job.
The local implementation cannot deliver it.
Evidence: `packages/queue/src/types/job.ts:17`.

**4. Reliability boundaries need repair before broader adoption.**

Journal claims a batch under one lease, then processes jobs serially.
A slow job can leave later jobs reclaimable before their original execution begins.
This is an inference from the claim and execution code, not a reproduced failure.
Evidence: `packages/journal/src/worker.ts:64`; `packages/journal/src/worker.ts:109`.

Its replay cursor advances by sequence number.
That does not establish transaction commit order.
Treat online catch-up as unsupported until a separate protocol is proved.
Evidence: `packages/journal/src/pg.ts:28`; `packages/journal/src/history.ts:237`.

Schedule reports a failed lock request as a lock skip.
That hides an infrastructure failure behind a normal scheduling outcome.
Evidence: `packages/schedule/src/runtime.ts:115`.

**5. Extension points are inconsistent and sometimes incomplete.**

HTTP has middleware.
Queue has middleware.
Dot has observers whose failures cannot veto lifecycle work.
Journal’s service-dependent effect declarations contribute no manifest actions.
These mechanisms should share conventions, while retaining their different contracts.
Evidence: `packages/http/src/dot.ts:99`; `packages/queue/src/index.ts:26`; `packages/dot/src/lifecycle-observer.ts:76`; `packages/journal/src/dot.ts:84`.

**6. Some generic machinery already depends on unsafe type erasure.**

Feature projection uses double assertions to recover types after dynamic composition.
Adding a universal plugin registry would increase this pressure.
The new preset needs a type proof before implementation, including negative cases.
Evidence: `packages/feature/src/index.ts:127`; `packages/feature/src/dot.ts:100`.

## 4. Target structure

Keep most package names.
Simplification should remove responsibilities and duplicate wiring, not merely rename directories.

| Package | Proposed responsibility and change |
|---|---|
| `@arki/dot` | Keep the kernel. Own plugin composition, lifecycle, diagnostics, and manifests. Move declaration-time runtime observations behind boot. |
| `@arki/app` **new** | Thin, optional backend preset. Assemble existing adapters from one feature list. Expose the resulting ordinary Dot graph. Own no database engine, event dispatcher, or worker loop. |
| `@arki/feature` | Keep static feature declarations and typed projections. Do not merge it into Journal. Static routers and repositories remain useful without Journal. |
| `@arki/journal` | Keep commands, entity history, reducers, transactional projections, and effect jobs together. Add supported command middleware and worker configuration. |
| `@arki/db` | Own database handles and transactions. Add explicit lazy connection configuration. Retire its event-projection builder after consumer migration. Keep driver imports isolated. |
| `@arki/queue` | Keep independent jobs and workflows. Separate declaration code from BullMQ execution. Move BullMQ-specific access to `./bullmq`. Retire `./runtime-local` after migrating its consumers. |
| `@arki/schedule` | Own schedule declarations and best-effort process execution. Keep durable scheduling an explicit queue integration. |
| `@arki/log` | Universal, dependency-free record creation and logger API. Instance-owned configuration. Optional `./node` sink and `./dot` adapter. |
| `@arki/telemetry` **new** | Explicit OpenTelemetry setup, provider ownership, and shutdown. Optional runtime SDK peers. No import-time registration. |
| `@arki/meter` | Keep browser analytics and framework integrations. Move server OpenTelemetry setup out. |
| `@arki/http` | Keep HTTP ownership. Add a small `./orpc` mounting helper. Do not create another procedure builder. |
| `@arki/kv` | Keep optional cache and rate-limit facilities. Do not make it a requirement for Journal. |
| `@arki/event-sourcing` | Deprecate, migrate the remaining consumer, then remove from the workspace. Do not unpublish existing releases. |

The existing database projection surface is visible at `packages/db/src/builder.ts:28` and `packages/db/src/builder.ts:283`.
Its removal is a proposal, not a claim that it is unused.

The target direction is:

```text
Application declarations
 ├─ feature, journal definitions, schemas, native oRPC routers
 └─ @arki/app preset
      └─ ordinary Dot plugins
           ├─ log / telemetry ownership
           ├─ database
           ├─ feature slices
           ├─ journal
           ├─ optional queue / schedule / KV
           └─ HTTP

Journal → Drizzle + Zod + small logging capability
Queue runtime → BullMQ + Redis
Schedule runtime → Croner
Telemetry runtime → selected OpenTelemetry SDK
Dot → assert + contracts + pure log + Zod + OpenTelemetry API
```

**“Core of the framework” means first-class assembly, documentation, diagnostics, and template support.**
It does not mean Dot imports every provider.

Dot should depend on none of Journal, database, queue, schedule, KV, HTTP, or telemetry SDKs.
Adapters retain their optional Dot peer.
The preset makes selection convenient without making the kernel larger.
This preserves the existing adapter boundary in `packages/dot/docs/principles.md:130`.

Universal entrypoints contain declarations and portable logic.
Server drivers live behind runtime-specific exports.
Optional peers prevent installing every driver merely to use declarations.
Node, Bun, Deno, browser, and React Native support must be claimed per entrypoint.

Use Math’s lint restrictions and runtime checks as the pattern.
Report skipped runtimes as skipped.
Its current runtime script explicitly permits a missing Deno installation.
Evidence: `packages/math/eslint.config.js:12`; `packages/math/package.json:137`.

## 5. The event model

A **business event** is an immutable fact about a completed domain change.
For example: `NoteAdded`, `OrderPaid`, or `SubscriptionCancelled`.

A command is a request to change something.
It can fail without creating an event.
An RPC call is a transport operation.
A job is work to execute.
A log record and a span describe execution.

Use three distinct mechanisms:

| Mechanism | Purpose | Durability and failure |
|---|---|---|
| Journal events | Business history and durable consequences | Stored transactionally. Failures can reject the write. |
| Typed operation middleware | Inspect, authorize, wrap, or veto an operation | In memory. Runs before the relevant commit or external action. |
| Diagnostic observation | Logs, traces, metrics, lifecycle notifications | In memory or exported. Observer failure must not change business success. |

This is deliberate separation.
An observer that can veto is middleware.
A notification that must survive a crash is durable work.

| Operation | Relationship to Journal |
|---|---|
| Database read | Direct Drizzle query. May produce a span. No Journal event. |
| Database write | Business changes use a command and Journal write. Cache tables, maintenance state, and other non-domain writes may remain ordinary transactions. |
| Command | Validates input and metadata, then executes within a transaction. Produces zero or more events. |
| RPC call | Authenticates and validates at the transport boundary. Calls a query or command directly. |
| Queue job | Executes independently. It may invoke commands. Enqueuing and starting a job are not automatically business events. |
| Cron tick | Attempts an invocation. Normally produces diagnostics only. Its handler may invoke a command. |
| Log line | Goes to the configured sink. Never automatically enters `journal_events`. |
| Trace span | Goes through OpenTelemetry. Correlation identifiers may also appear in Journal metadata. |

Preserve Journal’s existing atomic unit:
**events + current entity rows + inline projections + effect jobs commit together.**
The implementation already writes effect jobs inside the same write transaction.
Evidence: `packages/journal/src/write.ts:90`; `packages/journal/src/write.ts:239`; `packages/journal/src/write.ts:253`.

The proposed rules are:

- Validate command input and metadata before opening its transaction.
- Run command middleware inside that transaction.
- Run nested commands inside savepoints.
- Run reducers and inline projections without network calls.
- Reject the transaction if its handler or middleware fails.
- Run effect jobs only after commit.
- Treat worker wake-up as an optimization. Polling remains the recovery path.
- Never retry an arbitrary command automatically.
- Give externally retried requests an explicit business idempotency strategy.
- Keep direct writes to journal-owned entity columns exceptional and reviewable.

Journal already supplies nested savepoints and commit-aware wake-up.
Evidence: `packages/journal/src/command.ts:49`; `packages/journal/src/command.ts:67`; `packages/journal/src/command.ts:110`.

**Ordering is local.**
Entity versions define order within one entity.
There is no promised global commit order or effect execution order.
An event sequence number is useful for storage traversal, but is not a universal live subscription cursor.

For rebuilds, first support a documented quiescent procedure.
Do not advertise concurrent rebuilding until writes, projection state, and the catch-up boundary have a proved protocol.

**Effect delivery is at least once.**
A crash can occur after an external action succeeds and before its job is acknowledged.
A lease token prevents stale acknowledgement; it cannot undo an external action.
The current worker executes the effect before deleting its job.
Evidence: `packages/journal/src/worker.ts:120`.

Fix leases and shutdown before promoting the worker as the default.
Claim work close to execution, renew long leases, and define cooperative cancellation.
Shutdown must stop claiming work, request cancellation, and apply a bounded drain policy.
The present worker waits for its loop without forwarding a shutdown signal to `drain`.
Evidence: `packages/journal/src/worker.ts:190`; `packages/journal/src/worker.ts:211`.

**Postgres and Redis do not share a transaction.**
When a business change must cause a BullMQ job, a Journal effect performs the enqueue.
Use a stable delivery key.
The consumer still needs durable idempotency where duplicate execution matters.

**Croner remains best effort.**
Missed ticks during downtime are not recovered.
For durable recurrence, use the optional queue integration with an explicit occurrence identifier, timezone, retry policy, and missed-run policy.
Do not turn every timer tick into a domain event to manufacture durability.

## 6. The extension model

Use **typed function composition** as the common convention.
Do not create a global string-keyed hook registry.

The main asynchronous wrapper preserves the result type:

```ts
export type Around<C> =
  <R>(call: Readonly<C>, next: () => Promise<R>) => Promise<R>;

export type Decorate<F> = (next: F) => F;

export type Fields =
  Readonly<Record<string, string | number | boolean | null>>;

export type LogRecord = Readonly<{
  level: string;
  message: string;
  fields: Fields;
}>;

export type Logger = {
  info(message: string, fields?: Fields): void;
};

export type CommandCall = {
  name: string;
  depth: number;
  log: Logger;
};

export type CronCall = {
  name: string;
  scheduledAt: string;
};

export type Extension = Readonly<{
  name: string;
  log?: (record: LogRecord) => LogRecord;
  command?: Around<CommandCall>;
  cron?: Around<CronCall>;
}>;

export class RunPrevented extends Error {}
```

These are the complete contracts needed by the examples below.
RPC, job, and transaction wrappers use the same `Around<C>` pattern with their own context types.
Log transformation stays synchronous because logging should not force callers to await.

| Piece | Observe | Change or veto | Replace |
|---|---|---|---|
| Database | Query and transaction diagnostics | Wrap an explicit transaction boundary. Keep domain authorization in commands. | Select another compatible database provider before boot. |
| Journal | Read committed history; subscribe through durable effects | Command middleware before commit. Typed command-specific wrappers may transform validated input and revalidate it. | Replace the provider only if it preserves the transaction contract. |
| RPC | Request outcome and timing | Native oRPC middleware for context, authorization, input, and errors | Replace the mount or procedure declaration statically. |
| Queue | Job attempts and outcomes | Job middleware before execution | Select an execution provider with explicit supported capabilities. |
| Schedule | Runs, skips, and failures | Cron middleware may prevent a run | Select the process or durable scheduler explicitly. |
| Log | Subscribe to emitted records | Transform fields, filter, or redact records | Select the sink. |
| Telemetry | Native OpenTelemetry signals | Configure sampling, processors, and exporters | Select the SDK/provider at host boot. |

A global command wrapper can inspect common metadata.
It cannot safely rewrite arbitrary typed payloads.
Payload changes belong to a specific command’s schema-aware wrapper.

Apply extensions in declaration order.
The first wrapper is outermost.
Later log transforms receive earlier transforms’ output.
Freeze registration before active work starts.

Enforce `next()` at most once.
For commands, a failed `next()` must leave the command failed even if middleware catches it.
Middleware must not convert partial failure into a successful commit.
After-commit observers cannot veto or roll back anything.

Provider replacement is explicit configuration.
Duplicate providers are errors.
There is no “last plugin wins” rule and no mutation of an already published service.

Pure extensions are plain declarations.
They do not need Dot lifecycle hooks.
An extension that owns a connection, subscription, or buffer uses a Dot plugin for that resource.

Avoid a feature dependency cycle.
The current Journal adapter waits for feature slices before composing the journal.
A feature cannot simultaneously require that journal during boot.
Keep commands static and give effects their command runner at execution.
Evidence: `packages/journal/src/dot.ts:212`; `packages/journal/src/api.ts:88`.

## 7. Configuration

The preset should expose a small set of typed sections:
`database`, `journal`, `context`, `scheduleContext`, `http`, `log`, `telemetry`, and optional queue configuration.

Use these defaults:

| Setting | Default |
|---|---|
| Logging | Structured console output at info level, installed during boot |
| Telemetry | No exporter unless explicitly configured |
| RPC | `/rpc`, using the statically composed native oRPC router |
| HTTP | Port 3000; no listener until start |
| Journal effects | Conservative bounded concurrency with lease renewal |
| Schedules | UTC, overlap skipped, best-effort process scheduling |
| Redis and BullMQ | Absent unless selected |
| Process role | Combined backend for the simple preset; explicit API/worker roles for split deployments |

An override changes only its named field.
Changing the log level must not require rebuilding the sink configuration.
Arrays have explicit semantics: extension lists append in order; provider selections replace.
Do not introduce a generic recursive merge language.

Runtime configuration is a thunk.
Read and validate environment variables during boot.
Keep schemas, feature membership, and provider selection static.

The database adapter must accept an explicit connection URL.
Its current dependence on package-global `DB_URL` makes multiple databases and tests harder than necessary.
Evidence: `packages/db/src/dot.ts:177`.

There is a limit to zero configuration.
A durable backend needs a database and migrated tables.
Do not silently fall back to memory when production configuration is missing.
An empty Dot app can be zero-config.
A configured backend can need zero tuning.
Those are honest defaults.

Tests may explicitly select PGlite.
That does not imply a PGlite substitute for every BullMQ capability.

For telemetry, prefer explicit adapter instrumentation.
If Node auto-instrumentation is selected, the executable host must initialize it before dynamically importing the application.
A late Dot plugin cannot retroactively satisfy an import-first requirement.
The existing registration module documents that ordering and installs its own process-exit handlers.
Evidence: `packages/meter/src/integrations/otel/register.ts:4`; `packages/meter/src/integrations/otel/register.ts:28`.

The host owns process signals.
Dot owns application draining.
Telemetry shuts down after application resources finish producing diagnostics.
The preset supplies the same scoped logger to kernel diagnostics and application services.

## 8. What the app author writes

The example has one feature, one command, one asynchronous job, one cron, and one RPC procedure.
The job is a Journal effect because it is caused by a committed event.
It needs no separate queue server.

These are complete application modules.
A migrated PostgreSQL database is a deployment prerequisite.
The demo actor is explicit; a production context must derive it from authentication.

**Shared feature code, before and after:**

```ts
// notes.ts
import { z } from 'zod';
import { defineRelations } from '@arki/db/orm';
import type { DbServices } from '@arki/db/dot';
import { pgTable, text, integer } from 'drizzle-orm/pg-core';
import { defineFeature } from '@arki/feature';
import {
  initJournal, CommandError, type CommandRunner,
} from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { journalHandlers } from '@arki/journal/dot';
import { commandErrors } from '@arki/journal/orpc';
import { defineSchedule } from '@arki/schedule';
import { schedules } from '@arki/schedule/dot';
import { os } from '@orpc/server';

export const notes = pgTable('notes', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  version: integer('version').notNull().default(0),
});
export const receipts = pgTable('receipts', {
  eventId: text('event_id').primaryKey(),
  noteId: text('note_id').notNull(),
});
export const tables = journalTables();
export const relations = defineRelations({ notes, receipts, ...tables });

type Db = DbServices<typeof relations>['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const meta = z.object({ actor: z.string().min(1) });
export const j = initJournal.tx<Tx>().db<Db>().create({ meta });
type Run = CommandRunner<z.output<typeof meta>, Tx>;

const NoteAdded = j.event('NoteAdded', z.object({ text: z.string() }));
const note = j.entity('note', notes)
  .create(NoteAdded, event => ({ text: event.data.text }));

export const addNote = j.command(
  'add-note',
  z.object({
    id: z.string().regex(/^note_/),
    text: z.string().min(1),
  }),
  async (input, { write }) => {
    const result = await write(note, input.id, row => {
      if (row?.text === input.text) return [];
      if (row) throw new CommandError('CONFLICT', 'Note id already used');
      return [NoteAdded({ text: input.text })];
    });
    return result.row;
  },
);

export const receiptJob = j.effect('note-receipt', note, {
  NoteAdded: async (event, { db }) => {
    await db.insert(receipts)
      .values({ eventId: event.id, noteId: event.entityId })
      .onConflictDoNothing();
  },
});

export const dailyNote = defineSchedule<{ run: Run }>({
  name: 'daily-note',
  cron: '0 0 * * *',
  timezone: 'UTC',
  handler: async ({ run }) => {
    await run(addNote, {
      id: 'note_' + new Date().toISOString().slice(0, 10),
      text: 'Daily note',
    });
  },
});

const add = os.$context<{ run: Run }>()
  .use(commandErrors())
  .input(addNote.input)
  .handler(({ input, context }) => context.run(addNote, input));

export const notesFeature = defineFeature('notes', {
  router: { notes: { add } },
  use: [
    journalHandlers({ effects: [receiptJob] }),
    schedules([dailyNote]),
  ],
});
```

The receipt’s primary key and atomic conflict handling make repeated effect execution harmless.
This example does not claim exactly-once external delivery.
The cron is best-effort housekeeping.

**Before: explicit assembly using current APIs.**

```ts
// app.ts
import { db, type DbServices } from '@arki/db/dot';
import { defineApp } from '@arki/dot';
import { plugin, service, token, provide } from '@arki/dot/plugin';
import { composeRouter } from '@arki/feature';
import { plugs, tokens } from '@arki/feature/dot';
import { journal as journalPlugin } from '@arki/journal/dot';
import { schedule } from '@arki/schedule/dot';
import { routes, rpcMount, type RouteBundle } from '@arki/http';
import { http } from '@arki/http/dot';
import { RPCHandler } from '@orpc/server/fetch';
import { j, tables, relations, notesFeature } from './notes.js';

const features = [notesFeature] as const;
export const router = composeRouter(features);
type Db = DbServices<typeof relations>['db'];
type Journal = ReturnType<typeof j.compose>;
const needs = { db: service<Db>(), journal: service<Journal>() };
const mount = rpcMount('/rpc', { id: 'notes.rpc' });
const RpcRoutes = token<RouteBundle>()('rpcRoutes');

const gateway = plugin({
  name: 'gateway',
  needs,
  actions: [mount],
  boot({ db, journal }) {
    const handler = new RPCHandler(router);
    return provide(RpcRoutes, routes().rpc(mount, {
      context: () => ({
        run: journal.bind(db, { actor: 'local-demo' }),
      }),
      handle: async (request, context) => {
        const result = await handler.handle(request, {
          prefix: '/rpc', context,
        });
        return result.response
          ?? new Response('Not found', { status: 404 });
      },
    }));
  },
});

export const app = defineApp('notes')
  .use(db({ relations }))
  .useAll(plugs(features))
  .use(journalPlugin({ j, tables, features: tokens(features) }))
  .use(gateway)
  .use(schedule({
    features: tokens(features),
    needs,
    context: ({ db, journal }) => ({
      run: journal.bind(db, { actor: 'scheduler' }),
    }),
  }))
  .use(http({ port: 3000, bundles: [RpcRoutes] }));
```

**After: the proposed preset owns that repeated assembly.**

```ts
// app.ts — proposed @arki/app API
import { backend } from '@arki/app';
import { db } from '@arki/db/dot';
import { composeRouter } from '@arki/feature';
import { j, tables, relations, notesFeature } from './notes.js';
import { stampLogs, wrapCommands, pauseDaily } from './extensions.js';

const features = [notesFeature] as const;
export const router = composeRouter(features);

export const app = backend({
  name: 'notes',
  database: db({ relations }),
  features,
  journal: { j, tables },
  context: ({ db, journal }) => ({
    run: journal.bind(db, { actor: 'local-demo' }),
  }),
  scheduleContext: ({ db, journal }) => ({
    run: journal.bind(db, { actor: 'scheduler' }),
  }),
  extensions: [stampLogs, wrapCommands, pauseDaily],
});
```

Both versions use the same executable entry:

```ts
// main.ts
import { hookSignals } from '@arki/dot';
import { app } from './app.js';

hookSignals(await app.start());
```

The preset derives the gateway and collectors from the feature tuple.
It must retain exact router types and reject incompatible contexts.
It must also expose its expanded graph through `dot explain`.
Advanced applications can keep writing the explicit assembly.

The three requested plugins are pure extension declarations.
They use the types from section 6:

```ts
// extensions.ts
import { RunPrevented, type Extension } from '@arki/app/extensions';

export const stampLogs = {
  name: 'stamp-logs',
  log: record => ({
    ...record,
    fields: { ...record.fields, product: 'notes' },
  }),
} satisfies Extension;

export const wrapCommands = {
  name: 'wrap-commands',
  command: async (call, next) => {
    call.log.info('Command started', {
      command: call.name, depth: call.depth,
    });
    try {
      const result = await next();
      call.log.info('Command returned', { command: call.name });
      return result;
    } catch (error) {
      call.log.info('Command failed', { command: call.name });
      throw error;
    }
  },
} satisfies Extension;

export const pauseDaily = {
  name: 'pause-daily',
  cron: async (call, next) => {
    if (call.name === 'daily-note') {
      throw new RunPrevented('Maintenance');
    }
    return next();
  },
} satisfies Extension;
```

`pauseDaily` intentionally prevents that cron while installed.
The scheduler reports a policy skip, not an infrastructure failure.
`stampLogs` applies to the scoped logger used by the app, adapters, and kernel.
It cannot intercept arbitrary third-party console writes.

I checked the current assembly, these extension functions, and the after-example against a proposed preset declaration using an in-memory strict TypeScript compiler run.
It reported no diagnostics.
No files were written.
**The proposed preset implementation, complete generic inference, and runtime behavior remain unverified.**
Negative type tests are a release gate, not something this declaration check proves.

## 9. Where I say no

| Request taken literally | Recommendation | Cost of doing it anyway |
|---|---|---|
| Everything is an event | Journal business facts; call operations directly | More persistence, serialization, retries, and confusing failure semantics |
| Everything belongs inside Dot | Put convenience in the optional preset | Larger installs, platform restrictions, dependency cycles, and coupled releases |
| Any plugin can change anything | Permit typed extension slots and explicit provider replacement | Order-dependent behavior, broken transaction guarantees, and weaker types |
| One backend for every kind of job | Keep Journal effects and optional BullMQ jobs distinct | A new queue product, or an interface that conceals unsupported behavior |
| Every database write must be journaled | Journal domain changes; allow explicit infrastructure writes | Unhelpful event volume and events describing implementation details |
| Logs and spans belong in the durable journal | Correlate them without sharing storage | Database load, different retention needs, and diagnostic failures affecting business writes |
| Every library runs everywhere | Make declarations portable; constrain drivers honestly | Lowest-common-denominator APIs and untested compatibility claims |
| Zero-config production durability | Require storage and migrations | Hidden memory fallback, accidental data loss, or implicit infrastructure provisioning |

I would also reject monkey-patching the journal object as the extension API.
The current implementation deliberately looks methods up dynamically.
That makes replacement possible, but it is not a sufficient public contract.
Evidence: `packages/journal/src/journal.ts:134`.

## 10. Migration

Effort estimates are engineering days for one experienced maintainer.
They are planning estimates, not measured commitments.
App-specific behavior and migration validation dominate the uncertainty.

| Stage | Independently shippable result | Effort | Risk |
|---|---|---:|---|
| 1. Clarify and repair guarantees | Document ordering and replay limits. Fix worker leases, cancellation, lock-error reporting, and timed-out startup ownership. | 4–7 days | High correctness risk; small adoption surface |
| 2. Make foundations import-pure | Ship the log core, explicit sinks, explicit telemetry ownership, and deferred declaration validation. | 5–8 days | Medium to high compatibility risk |
| 3. Add supported extension points | Command middleware, typed schedule veto, scoped logger transforms, and explicit database configuration. | 4–7 days | Medium; transaction semantics need strong tests |
| 4. Prove the preset | Implement one constrained backend preset and migrate a Journal app. Preserve an explicit-composition escape hatch. | 4–6 days | Medium; type inference and ownership are the gates |
| 5. Fix the template | Generate the proved composition. Remove product-specific worker imports and naming. Verify a generated app. | 2–4 days | High multiplication risk if skipped |
| 6. Finish Journal adoption | Move Kapodopera’s remaining Emmett behavior. Migrate other apps one at a time. | 3–8 days for the remaining Emmett boundary; then per app | High domain risk |
| 7. Retire misleading queue compatibility | Migrate local-runtime consumers, separate BullMQ-specific APIs, and remove the emulation. | 4–8 days plus callers | High compatibility risk |

Do not wait for stage 7 to ship stages 1–5.
Do not require all 40 apps to adopt Dot before benefiting from pure logging or explicit telemetry setup.

The local queue adapter deserves particular care.
It substitutes parameters into SQL text.
Its array branch does not escape apostrophes as the scalar branch does.
Do not carry that mechanism into a new provider abstraction.
Evidence: `packages/queue/src/runtime-local/adapter.ts:21`; `packages/queue/src/runtime-local/adapter.ts:44`.

For Journal migration, preserve current rows and define the starting history boundary.
The approved design already chooses a fresh start rather than importing Emmett history.
Do not invent a second historical migration project.
Evidence: `packages/journal/docs/specs/2026-10-09-journal-design.md:45`.

During rolling upgrades, preserve registered effect names until pending jobs drain.
Unknown effects are excluded from current worker claims.
Deleting or renaming a handler can therefore strand jobs.
Evidence: `packages/journal/src/worker.ts:59`; `packages/journal/src/worker.ts:73`.

Published-consumer changes must be named explicitly:

| Package | Breaking change to announce |
|---|---|
| `@arki/log` | Remove import-time environment configuration and implicit shared Pino ownership. Replace global configuration with scoped instances. |
| `@arki/meter` | Move `./otel` and `./otel/register`. Provide a transition release, then remove import-time registration. |
| `@arki/db` | Change driver dependency installation and retire the projection builder. Explicit URL support itself can ship additively. |
| `@arki/queue` | Remove `./runtime-local`; move full BullMQ job access to a BullMQ-specific surface; change provider installation requirements. |
| `@arki/schedule` | Add distinct lock-failure and policy-skip outcomes. Move declaration validation to explicit validation/boot. Exhaustive status switches may break. |
| `@arki/journal` | Change declaration-error timing and worker configuration. Keep event names and stored payloads stable unless an explicit data migration is supplied. |
| `@arki/feature` | Move duplicate-composition failure out of module import. Preserve static router inference. |
| `@arki/dot` | Change effectful configure/diagnostic behavior to respect the boot boundary. Preserve existing plugin ordering and ownership. |
| `@arki/http` | Announce any export or driver-installation changes. The oRPC helper can be additive. |
| `@arki/event-sourcing` | Deprecation and eventual workspace removal. Existing published versions remain available. |
| `@arki/kv` | No mandatory breaking change in this proposal. |
| `@arki/app`, `@arki/telemetry` | New packages, with no existing consumer contract. |

Existing plans:

- **004 — keep, narrow.** Characterize compatibility before replacing logging internals. Do not make severity-sorted batching a permanent requirement for the new logger. The plan explicitly preserves that ordering today. `plans/packages/004-log-characterization-tests.md:95`.
- **007 — change.** Keep the zero-dependency core and runtime checks. Replace the proposed mutable settings singleton and copied logger implementations with one instance-owned implementation. `plans/packages/007-log-zero-dependency-core.md:204`; `plans/packages/007-log-zero-dependency-core.md:218`.
- **009 — keep the lock-outcome fix.** Inject the logger through runtime configuration. Keep unrelated resilience work separate. `plans/packages/009-schedule-lock-errors-and-resilience-helper.md:225`; `plans/packages/009-schedule-lock-errors-and-resilience-helper.md:240`.
- **010 — replace.** Its Node entry calls `installNodeLogging()` during import. That directly conflicts with this brief. Replace it with explicit boot installation and update the package-plan index. `plans/packages/010-log-main-entry-switch.md:144`; `plans/packages/README.md:56`.

Each stage needs focused verification:
import purity, negative type cases, transaction rollback, worker crash recovery, duplicate delivery, shutdown ownership, and generated-app startup.
Browser and React Native claims require their own executed checks.
A passing Node check is insufficient.

## 11. Decisions for the founder

1. **Where should “core” live?**  
   **A — optional `@arki/app` preset, recommended:** convenient defaults with a small Dot kernel.  
   **B — mandatory kernel services:** fewer visible choices, but every consumer pays the dependency and portability cost.

2. **What should the default background path be?**  
   **A — Journal effects plus optional BullMQ, recommended:** two honest contracts with clear ownership.  
   **B — rebuild one universal job engine:** a substantial infrastructure project with migration and operational costs.

3. **What may plugins override?**  
   **A — typed hooks and selected providers, recommended:** predictable behavior and strong types.  
   **B — arbitrary runtime replacement:** more freedom, but no reliable composition or transaction guarantees.

4. **What does cron promise?**  
   **A — best effort by default, durable recurrence explicit, recommended:** cheap housekeeping and clear business scheduling.  
   **B — every tick durable:** more state, cleanup, retries, and operational configuration for all users.

5. **How strict is import purity?**  
   **A — enforce this brief’s no-observation/no-throw rule, recommended:** explicit validation and reliable tooling.  
   **B — allow import-time validation and automatic Node setup:** less startup wiring, but weaker portability and inspectability.

## 12. Not examined

- Deployed process topology, production configuration, and actual exporter activity are **not verified**.
- Full behavior of every importing app is **not verified**.
- Browser, Deno, Bun, and React Native execution was not tested.
- Database performance, production workload sizes, and storage retention needs were not measured.
- No crash, lease-expiry, online-replay, or shutdown failure was reproduced.
- Authentication and authorization behavior across all RPC procedures was not audited.
- The new preset and extension runtime were not implemented.
- No repository test suite, build, installation, or migration was run.
- No `proposal-*.md` or `synthesis*.md` file was read.

COST NOTE: Exhaustive import dumps obscured census totals → emit counts and one anchor per app/package first, then inspect runtime entrypoints.