# RFC: The core of Arki Dot, centred on the journal

- **Status:** PROPOSED (2026-10-12). All five decisions answered 2026-10-13
  (section 6). Decision 3 is implemented (section 6a).
  The faults in section 3 are FIXED, except the replay-order claim, which is
  not checked.
- **Scope:** `@arki/dot` and the pieces that become its core: db, rpc,
  queues, crons, telemetry, logs, with `@arki/journal` at the centre.
- **Inputs:** in the folder `2026-10-12-dot-core-centred-on-journal/` next
  to this file: `brief.md` (the shared brief), `proposal-fable.md`,
  `proposal-astra.md`.

Two architects worked from the same brief without seeing each other:

- Fable: `proposal-fable.md` (561 lines)
- Astra: `proposal-astra.md` (807 lines)

This file compares them and gives one merged recommendation. Every claim
marked "checked" was opened in the code by this session, not taken on trust.

One note on wording. The brief first said "core things for Arki". The founder
corrected it to "core things for Arki Dot". Fable got the correction mid-run.
Astra did not. Astra's answer is still about Dot throughout, so it was not
re-run.

## 1. Where both agree

These points came out the same in both reviews. Treat them as settled unless
the founder disagrees.

1. **The journal is the right centre.** It already stores the event, the
   updated row, the projections and the follow-up job in one database
   transaction (`packages/journal/src/write.ts:239-255`, checked).
2. **The Dot kernel stays small.** `@arki/dot` must not import the database,
   the journal, the queue or Redis. They are core as plugins that ship with
   Dot, not as kernel imports. One real app (novelette server) boots with no
   database at all.
3. **Not everything is an event.** Both said no to this part of the request,
   for the same reason. Only a fact about business data is a stored journal
   event. A command, an rpc call, a cron tick, a log line and a trace span are
   in-memory signals. Storing them would turn every log line into a Postgres
   write and fill the event table with rows that cannot be replayed.
4. **One way to extend: a typed wrapper.** A function that receives the call
   and a `next`. It can watch, change, stop or replace. Plugins run in the
   order they are declared. The first one is outermost. No registry keyed by
   strings.
5. **No `@arki/rpc` package.** 29 apps use oRPC directly. oRPC already has
   middleware. A wrapper would be a second thing to keep in step.
6. **Logging must stop doing work on import.** `@arki/log` reads the
   environment and builds pino when the file loads
   (`packages/log/src/lib/config.ts:118`, checked). The Dot kernel imports it
   (`packages/dot/src/kernel/app-instance.ts:8`, checked). So importing Dot
   breaks Dot's own rule.
7. **Split server telemetry out of `@arki/meter`.** New `@arki/telemetry`.
   Meter keeps browser analytics, used by 15 apps. Server telemetry is used
   by 3.
8. **Journal follow-up jobs are the default "run this later" path.** BullMQ
   stays, as an optional step up.
9. **Delete `@arki/queue/runtime-local`.** One app uses it (loonyjobs).
10. **Retire `@arki/event-sourcing`** once Kapodopera has moved (50 files).
11. **Fix the new-app template early.** Its server imports Kapodopera's code
    (`turbo/generators/templates/application/server/src/index.ts:16-20`,
    checked).
12. **Replacing a core piece is explicit.** No "the last plugin wins".

## 2. Where they differ

| Topic | Fable | Astra | Recommendation |
|---|---|---|---|
| What "core" looks like to an app author | Six core plugins. The app file stays a `defineApp().use(...)` chain of about seven lines. | A new `@arki/app` package with one `backend({...})` call that expands to the same plugins. | Core plugins first. Decide on the one-call preset after one app has run on them. See decision 1. |
| How a plugin attaches | Hooks live on the service: `journal.hooks.command.around(...)`. A plugin declares it needs the service and attaches in `boot`. | A plain `Extension` object with fixed slots (`log`, `command`, `cron`), passed to the preset. | Fable's. It uses the dependency system Dot already has, keeps the app's own metadata type, and needs no central list of slots. |
| Rules for a wrapper | Light. A wrapper may pass a changed input to `next`. Command hooks wrap the transaction from outside. | Strict. `next` at most once. A wrapper cannot turn a failed command into a success. A wrapper for all commands cannot rewrite the input. Command wrappers run inside the transaction. Registration is frozen before work starts. | Astra's rules on Fable's mechanism. Running inside the transaction means an error anywhere rolls back cleanly. |
| Is the journal worker ready to be the default? | Assumed yes. | No. Found three faults (section 3). Fix them first. | Astra's. All three are confirmed. |
| The existing log plans | Keep 004, 007, 010. | Keep 004. Change 007. Replace 010. | Astra's. See section 4. |
| May a declaration throw on import? | Not raised. | No. Collect the errors and raise them at boot. Notes that the doctrine file contradicts itself. | Neither as stated. See decision 3. |
| Crons inside `@arki/queue` | Delete them. Crons live only in `@arki/schedule`. | Keep them as the durable option. In-process crons skip runs while the app is down. | Keep them until `@arki/schedule` has a durable option. See decision 4. |
| The rpc mount | Shown as already handled by `http({ features })`. | Shows the hand-written "gateway" plugin (about 20 lines) apps need today. Proposes a small helper in `@arki/http`. | Astra's. The gateway is the real boilerplate in the app file. |
| Slice collection | Four adapters each copy the same "collect feature slices" code with unsafe casts. Unify into one typed helper. | Notes the casts. Warns any preset needs negative type tests first. | Both. Do Fable's helper, gated by Astra's type tests. |
| Database URL | Unchanged. | Add an explicit `url` option. Today the adapter only reads `DB_URL` (`packages/db/src/dot.ts:177`, checked). | Astra's. It is additive. |
| The untyped `$config` bag in Dot | Delete it. | Not raised. | Delete. Checked: only Dot's own files read it. |

## 3. Faults found in current code (all checked)

Astra found these. Fable did not look. Each was confirmed by reading the code.

**All six were fixed on 2026-10-12**, the same day:

| Fault | Fix | Proof |
|---|---|---|
| 1. One lease per batch | `drain` claims one job at a time, right before it runs. | Test: while a job runs, no other job of the batch holds a lease. |
| 2. Shutdown never reaches a job | `stop()` aborts the signal `drain` and the effect get. `drain` claims nothing after an abort. | Test: an effect that waits for the abort lets `stop()` resolve. Before, it hung. |
| 3. Renamed effect strands work | New `journal.strandedJobs(db)` counts pending jobs no effect claims. Jobs stay untouched, for rolling deploys. | Test. README "The worker" section. |
| 4. Array quotes in local queue SQL | The array branch escapes `'` like the other branches. | Test against a real PGlite. It fails on the old line with a syntax error. |
| 5. Queue reads `NODE_ENV` at declaration | The `isDev` default is a getter, read on use. | Typecheck; no test reads it at import any more. |
| 6. Doctrine contradiction | `composition-doctrine.md` §1 now allows a throw that depends only on the source (a duplicate key), never one that depends on the world. This applies decision 3, option A. Revert that paragraph if the founder picks B. | Doc change. |

Changesets: `.changeset/journal-worker-claims-and-stop.md` (journal minor),
`.changeset/queue-local-array-quotes-and-lazy-isdev.md` (queue patch).

Remaining limit, recorded in the journal README: a single job longer than the
60-second lease can still be claimed by a second worker. Lease renewal while
a job runs was not built.

The original findings:

1. **One lease for a whole batch of jobs.** The worker claims up to 20 jobs
   with one expiry time, then runs them one after another
   (`packages/journal/src/worker.ts:64-95,109-143`). If an early job is slow,
   the lease on the later ones runs out before they start. A second worker
   can then take them, and they run twice.
2. **Shutdown never reaches a running job.** The worker loop calls `drain`
   without a stop signal (`packages/journal/src/worker.ts:190`). `drain` then
   makes its own signal that is never fired (`worker.ts:58`). A job cannot
   learn that the app is stopping.
3. **Renaming a follow-up job strands its queued work.** The worker only
   claims jobs whose name it knows (`worker.ts:59,73`). Jobs queued under an
   old name are never claimed, never failed and never reported.
4. **Unsafe SQL text in the local queue adapter.** It builds SQL by pasting
   values into the text. The branch for arrays does not escape the `'`
   character (`packages/queue/src/runtime-local/adapter.ts:21-29,44`). This
   adapter is the one both reviews want deleted.
5. **`@arki/queue` reads `NODE_ENV` when a queue is declared**
   (`packages/queue/src/init.ts:62`). That is an environment read at import.
6. **Dot's doctrine file contradicts itself.** Line 17-19 says importing must
   never throw. Line 94-96 requires a throw at import for a duplicate key
   (`packages/dot/docs/composition-doctrine.md`).

Not checked: Astra's claim that replaying events by sequence number can miss
events that commit out of order (`packages/journal/src/history.ts:237`).
Astra marks it as reasoning, not a reproduced failure.

Also worth knowing: no app uses the journal's Dot plugin today. Games
Platform starts the worker by hand. Everseek and Kapodopera run no worker.
So "journal inside Dot" is designed but not yet proven by any app.

## 4. What this means for the plans in `plans/packages/`

| Plan | Verdict | Why |
|---|---|---|
| 004 log tests | Keep | Still the safety net before changing the logger. Do not treat "flush sorts by level" as a rule the new logger must keep. |
| 007 log core | Hold and revise | It builds one shared, changeable `settings` object. A Dot `log()` plugin needs each app to own its logger, so one plugin can change it. |
| 009 schedule lock errors | Keep | Both reviews want it. Later it folds into the cron hook. |
| 010 log main entry | Hold, likely replace | Its Node entry installs logging at import. That is the same rule break this work sets out to remove. See decision 2. |

## 5. Merged recommendation

**Shape.** A small kernel plus core plugins that ship with Dot: `log()`,
`db()`, `journal()`, `schedule()`, `telemetry()`, and rpc through `http()`.
Each core piece exposes typed hooks on its own service. A plugin says which
service it needs and attaches in `boot`. Business facts and their direct
consequences go through the journal. General background work and durable
crons go through BullMQ (`@arki/queue`), the default (decisions 4 and 5).
Everything else is an in-memory wrapper.

**Order of work.** Each stage ships alone and leaves every app working.

| Stage | What | Size | Risk |
|---|---|---|---|
| 0 | Fix the template server: remove the Kapodopera imports. DONE 2026-10-13. | Small | Low |
| 1 | Repair the journal worker (faults 1-3, DONE 2026-10-12) and the schedule lock outcome (plan 009, DONE 2026-10-13). | Medium | High on correctness, few users today |
| 2 | Pure logger core, a `log()` Dot plugin, kernel moves onto it, import test on `@arki/dot`. Fix the `NODE_ENV` read in queue. | Large | Medium: every server logs |
| 3 | The hook helper. Hooks on journal commands, writes and jobs, on cron runs, and on log records. Astra's rules. | Medium | Low: additive |
| 4 | `@arki/telemetry` split out of meter, with a bridge from hooks to OpenTelemetry. | Medium | Low: 3 apps |
| 5 | One typed slice-collection helper. An rpc mount helper in `@arki/http`. Explicit database URL. Delete `$config`. | Medium | Low |
| 6 | Prove it: the template and one journal app boot through Dot with all core plugins. Then decide on the one-call preset. | Medium | Medium |
| 7 | Finish journal adoption, remove `@arki/event-sourcing`. In `@arki/queue`, delete only `runtime-local` (one app). Add `durable: true` crons to `@arki/schedule`, backed by the queue's repeatable jobs. | Large, mostly app work | Medium |

## 6. Decisions for the founder

**Answered 2026-10-13:**

| # | Decision | Founder's answer | What it changes |
|---|---|---|---|
| 1 | App shape | **Core plugins.** No `@arki/app` preset now. | None. Revisit a preset after stage 6. |
| 2 | Node logging startup | **Explicit.** Dot apps get it from `log()`; other apps add one startup line. | Plan 010 is replaced. Plan 007 is revised: each app owns its logger, no shared mutable settings. |
| 3 | Where declarations check for mistakes | **The ladder (option C) with refactors R1-R6** (section 6a): types first, then a coded throw at import, then boot for anything that depends on the world. | Doctrine §1 states the ladder. R1-R6 done 2026-10-13. |
| 4 | What a cron promises | **Each cron chooses.** `defineSchedule({ ..., durable: true })` is backed by a BullMQ repeatable job; the default (`durable: false`) runs in process and skips ticks missed while down. A durable cron with no queue plugin fails boot with a coded error. | `@arki/schedule` gains a durable mode that hands the cron to `@arki/queue`. The queue's cron support stays: it becomes that backend.  DONE 2026-10-13: `durable: true` + `durableScheduler()` in `@arki/queue/dot`; checked against a real Redis (one run per tick across two replicas). |
| 5 | Default "run later" path | **BullMQ stays the default.** Journal effects are for consequences of committed business events. | The template keeps Redis and `@arki/queue`. Stage 7 no longer slims the queue's cron or job features. |

The original options and recommendations, kept for the record:

1. **Core plugins only, or also a one-call preset?**
   A: core plugins, app file stays a short chain. B: add `@arki/app` with
   `backend({...})`. Trade-off: B is less to type but is a new package whose
   types must stay exact across every feature. Recommendation: A now, revisit
   after stage 6.
2. **How does Node logging get switched on?**
   A: explicitly. Dot apps use the `log()` plugin. Other apps add one line at
   startup. B: automatically on import, as plan 010 does. Trade-off: A keeps
   the "import does nothing" rule but 46 apps do not boot through Dot, so
   each needs that line. B needs no app change but keeps the rule break.
   Recommendation: A.
3. **May a declaration throw on a programmer error at import?**
   A: yes, for checks that depend only on the code, such as a duplicate key.
   No environment reads. Fix the doctrine wording. B: never. Collect errors
   and raise at boot. Trade-off: B is purer but adds a collection step to
   every declaration helper. Recommendation: A.
4. **What does a cron promise?**
   A: best effort in-process by default. Durable crons stay an explicit queue
   feature. B: every cron is durable. Trade-off: B needs stored state for
   every schedule. Recommendation: A, and do not delete the queue's cron
   support until there is a durable replacement.
5. **Is the journal the default "run later" path?**
   Both reviews say yes, with BullMQ optional. Recommendation: yes, but only
   after stage 1.

## 6a. Decision 3 in depth: where a declaration checks for mistakes

Added 2026-10-13 at the founder's request ("I want the best way; we can
refactor"). Evidence: a survey of the ten core packages, with the key claims
re-checked in the code.

### What exists today

- About 52 places throw while a declaration runs: `composeRouter`,
  `j.entity`, `defineSchedule`, the queue's job builder, and others.
- **None of them depends on the world.** All 9 throws that read env or the
  network (db URL, KV URL, `defineEnv`) already run at boot or lazily. The
  rule "never observe the world at import" already holds.
- **Only 6 of the 52 are also caught by TypeScript.** `composeSchema` in
  `@arki/db` rejects a duplicate key in the type
  (`packages/db/src/composition.ts:24-42`). `composeRouter` and
  `composeRepos` do not: their type is a plain intersection
  (`packages/feature/src/index.ts:134`), so a duplicate key is found only by
  the throw at `:146`. The doctrine (§4) claims otherwise.
- About 17 are partly typed, and about 29 are runtime only. The 9 throws in
  the queue's builders (`.handler()` before `.name()` or `.input()`,
  `packages/queue/src/job-builder.ts:101-107`) could all be type errors.
- **Dot's CLI already survives a throw at import.** `dot explain` and
  `dot doctor` catch it and print a coded `AppImportFailed` error with the
  original message (`packages/dot/src/cli/discover.ts:146-158`). The
  original error's own code is kept only inside the message text.
- About 20 of the throws are plain `Error` with no code: feature (2),
  journal (about 15), queue builders (9), db builder (2). The others use
  coded errors (`ScheduleError`, `HttpConfigError`, `DbCompositionError`).

### The three options

**A. Throw at import, for mistakes in the code only** (what is committed now).

**B. Never throw at import. Collect the problems and raise them at boot.**
This fails on four counts:

1. 46 of 47 apps do not boot through Dot. A router built by
   `composeRouter` is used directly by oRPC. If the duplicate-key check
   moved to Dot's boot, those apps would never run it. The second feature
   would silently replace the first. A loud error becomes a silent bug.
2. Collecting needs a place to put the problems. That is either a global
   list (the doctrine forbids global changes at import) or a list carried
   by every value, which every consumer must remember to check.
3. Its main benefit, good tooling output, already exists: the CLI turns an
   import throw into a coded error.
4. Its other benefit, "see every problem at once", is better delivered by
   TypeScript. `tsc` reports every type error in one run.

**C. The ladder (recommended).** Each check lives on the earliest step that
can see it:

1. **Types** when TypeScript can express the check. `tsc` reports every one
   at once, in the editor, before any code runs.
2. **A throw at import** when the check depends only on the source but types
   cannot express it (a cron string that does not parse, a key column that
   is nullable). It fails at the line of the mistake, in every environment,
   every time, and `dot explain` reports it with a code.
3. **Boot** for anything that depends on the world (env, files, network,
   clock). Never at import.

Two more rules:

- **Never move a check down the ladder.** A check that can run at import
  must not wait for boot, because some consumers never boot.
- **Keep a runtime throw behind every type check.** Plain JavaScript and
  type casts skip the types. The throw is the backstop.

### The refactors option C needs

| # | Change | Size | Moves |
|---|---|---|---|
| R1 | `composeRouter` and `composeRepos` reject duplicate keys in the type. Move `DuplicateKeys` from `@arki/db` to `@arki/ts` and use it in both packages. | Small | 2 checks to types; makes doctrine §4 true |
| R2 | A coded error for every declaration mistake: a `code` and a `remediation`. Convert the about 20 plain `Error` throws (journal gets a new `JournalError` code for bad definitions). | Medium | Every import failure is coded |
| R3 | `dot explain` / `dot doctor`: when an import fails and the cause carries a code, print that code and its remediation, not only `AppImportFailed`. | Small | Better tooling output |
| R4 | The queue's job, schedule and flow builders track their state in the type: `.handler()` and `.build()` exist only after `.name()` and `.input()`. The runtime throws stay as backstops. | Medium | 9 checks to types; matters more now BullMQ is the default |
| R5 | `@arki/http` mount paths typed as `` `/${string}` ``. | Small | 1 check to types |
| R6 | Doctrine §1 states the ladder. Doctrine §4 is corrected or made true by R1. | Small | — |

Breaking changes: R1 and R4 can turn code that compiled into a type error,
but only code that would already throw at import. R2 changes error classes,
which breaks a consumer that matches on `instanceof Error` plus a message.

## 7. Limits of this review

- Nothing was built or run. No test suite, no type-check of the proposed APIs
  beyond Astra's in-memory compile of its own examples.
- Deployed setups were not inspected.
- Fable's count of 15 unsafe casts in the four adapters was only partly
  confirmed (9 found with a narrow search).
- The uncommitted journal work in the tree was read as it stood on
  2026-10-12 and may have moved since.

## 8. What the journal is still missing (2026-10-13)

Two reviewers, blind to each other, answered "what is `@arki/journal` missing?"
Fable's list and Astra's list overlapped on most points. Every Astra finding
below was opened in the code before it was adopted. The yardstick for "now"
is: it touches the two tables, an invariant, or history that cannot be
backfilled. Everything else waits for the first app that asks.

Status of this section: **PROPOSED**. The founder chose "build all six now"
on 2026-10-13. Implementation starts after the founder approves the designs
below.

### 8.0 The name stays `journal`

Both reviewers were asked whether `journal` is the right name, or whether
`event bus` or `bus` fits better. Both said keep `journal`, for the same
reason. The package is a persistence layer: it records changes durably and
in the same transaction as the entity row. "Journal" names that. "Bus" names
routing between producers and consumers, which the package does not do:
handlers are fixed at compose time, nothing subscribes at runtime, and the
transaction is the delivery. Akka calls the same component a journal. Marten
and Emmett, the family this package replaced, pair event appends with inline
projections in the same way.

Proposed README opener, to stop the question coming back:

> `@arki/journal` is a transactional journal for Drizzle entities: it
> atomically records immutable domain events, updates entity rows and inline
> projections, and queues durable effects for execution after commit.

### 8.1 Build now

| # | Gap | Found by | Why now |
|---|---|---|---|
| 1 | Commit-order safety for `seq` | both | Every checkpoint ever taken is suspect until fixed |
| 2 | Causation and correlation ids | both | History cannot be backfilled |
| 3 | Erasure contract | Astra | Personal data is already in event rows; the schema rule is hard to retrofit |
| 4 | Baseline for rows older than the journal | Astra | Original values are lost after the first write; Kapodopera is mid-migration |
| 5 | Gap detection in replay | Astra | Correctness bug: repair can save a wrong row |
| 6 | Around-hooks on commands and effects | Fable | Section 5 committed to it; telemetry and log plugins block on it |

**1. Commit-order safety.** `seq` is a `bigserial`
(`packages/journal/src/pg.ts:28`, checked). Postgres assigns it at insert,
not at commit. Transaction A takes seq 1, transaction B takes seq 2 and
commits first, a reader checkpoints at 2, A commits, and A's event is never
read. `rerun` has this hole today (`history.ts:243`, checked), and every
future async projection or subscriber would inherit it.

Design: `write` takes `pg_advisory_xact_lock(<fixed key>)` at its start,
before the row lock, so every journal transaction takes its locks in the
same order and two commands writing two entities cannot deadlock. The lock
is re-entrant inside a transaction and held until commit, so seq order
equals commit order. Cost: event appends across the app are
serialised, one committing transaction at a time. That is fine for these
apps and is the simplest correct protocol. The alternative, xid8 visibility
tracking as Marten does, was rejected as too much machinery. PGlite supports
advisory locks, and it is single-connection anyway. Test: on real Postgres,
two overlapping transactions; the one that commits later has the higher seq.

**2. Causation and correlation ids.** Today `meta` carries only what the app
puts in, and a child command inherits the parent's meta unchanged
(`command.ts:67`, checked). Nothing records which command wrote an event or
which job caused that command. Payment chains are the first need: webhook,
then subscription, then entitlement.

Design: three nullable columns on `journal_events`, all stamped by the
library, never by the app:

- `command_id`: a new `cmd_` id per `run`, nested runs included.
- `cause_seq`: inside an effect's `ctx.run`, the seq of the event the job
  was for. Null for a top-level run.
- `correlation_id`: inherited from the cause event, else from the parent
  run, else a new `cor_` id. `run` and `bind` accept an optional
  `correlationId` so a request id can seed it.

Exposed on every recorded event as `event.commandId`, `event.causeSeq`,
`event.correlationId`. Astra proposed putting these in the app's meta JSON
instead. Columns were chosen because the library already knows the chain,
an app should not thread it by hand, and columns can be indexed. Migration:
additive, three nullable columns, in the three apps and the payments
package that own journal tables.

**3. Erasure contract.** Kapodopera stores message content inside event
rows (`apps/kapodopera/backend/src/features/_shared/messaging/conversation.ts:27`,
checked), and delete only flips a status. There is no way for personal data
to leave the log.

Design: `j.event(type, schema, { erased: data => data' })` lets an event
declare its erased form from its data, so the non-personal parts can stay.
Because it takes the data, it cannot be checked at import; `forget` parses
the form with the schema and refuses with `BAD_DEFINITION`, rolling back,
if it does not fit. A new verb `journal.forget(db, entity, id)` locks the
row, rewrites `data` of every event of that entity that has an erased form,
stamps `erased_at`, then runs `repair` so the row matches the erased
history. Events without an erased
form are left alone: they hold no personal data. Projections are not rerun;
the app owns its read models and the README says so. Column: `erased_at
timestamptz null` on `journal_events`. Crypto-shredding was rejected: it
needs a key per entity from day one and the apps are too small to pay for
it.

**4. Baseline for rows older than the journal.** A pre-journal row starts
its history at version 2, and replay, verify and repair refuse it by design
(`write.ts:103`, `entity.test.ts:166`, checked). After the first journal
write the original values exist only in the row, and the next write
overwrites them.

Design, revised during implementation: `journal.adopt(tx, entity, id, {
meta, events })` locks the row, requires version 0 and an empty log, and
calls `events(row)` for exactly one create event built from the stored
row. Its `.create` reducer must rebuild the row exactly, column by column,
or `VALUE_MISMATCH` and nothing changes. The event is recorded as version 1
and the row moves to version 1. Projections run and effects are queued as
for any write. The reserved `$adopted` event first proposed was dropped:
row values such as dates and numerics do not survive a JSON round trip, and
only the entity's own create reducer knows how to build a row from JSON, so
the library cannot write a generic snapshot event. The start-at-2 behaviour
stays for rows nobody adopted, so nothing breaks. No schema change.

**5. Gap detection in replay.** Replay checks only that the first version
is 1 (`history.ts:130`, checked). A missing middle version folds silently
into a wrong row, and `repair` would save it. Astra reproduced this on
PGlite by deleting version 2 of a three-event history.

Design: after loading, replay requires versions 1..n with no holes, and
requires the stored row's version to be at most n. A hole throws a new
`JournalError` code `HISTORY_GAP`, naming the first missing version.
`verify` reports it, `repair` refuses it. No schema change.

**6. Around-hooks on commands and effects.** Section 5 decided the one
extension mechanism is a typed wrapper on the service
(`journal.hooks.command.around(fn)`). Nothing is built yet (grep for
`hooks` in `packages/journal/src` finds nothing, checked). The telemetry
and log plugins of section 5 cannot start without it.

Design, Astra's rules on Fable's mechanism:

- `journal.hooks.command.around(fn)` and `journal.hooks.effect.around(fn)`.
  `fn(ctx, next)`. The command context carries `name`, `input`, `meta`,
  `commandId`, `correlationId`; the effect context carries `name`, `event`,
  `jobId`, `attempt`.
- `next` at most once; a second call throws. A wrapper may not rewrite
  `input`. If `next` rejects, the wrapper's promise rejects: a wrapper
  cannot turn a failure into a success.
- Command wrappers run inside the transaction, so an error anywhere rolls
  back cleanly. Effect wrappers run inside the lease.
- Registration is frozen at the first `run`, `drain` or `worker.start()`.
  A later registration throws `BAD_DEFINITION`.
- Wrappers run in registration order, first one outermost.

Hooks on `write` are left out for now. They are additive and no plugin
needs them yet.

### 8.2 Build when an app asks

Each of these is additive: a new table, a new column, or a new option. None
changes an existing row, an invariant, or an API.

| Gap | Trigger | Shape |
|---|---|---|
| Lease heartbeat for effects over 60 s | Avocabo moves AI summarisation into effects | `ctx.heartbeat()` or auto-renew; `lease_until` and `lease_token` already exist |
| Idempotency receipts for commands | EverSeek's RevenueCat webhook retries; today it passes no delivery key | A receipts table keyed by delivery key, written in the command's transaction |
| Checkpointed async projections | A slow leaderboard or report | A cursor table; reset, catch-up, cutover. Needs 8.1 item 1 first |
| Run-at and priority for jobs | Delayed notifications | `available_at` exists; priority is one column and an index |
| Expected version from the client | Games Platform hand-checks stale moves today | One optional argument to `write` |
| After-commit tap and cross-process wake | A second Games Platform instance; its `journal.root.ts` comment already names the loss | A non-durable effect mode, `durable: false`, that may not call `run`; a `LISTEN/NOTIFY` adapter for wake |
| Admin verbs | The founder has to retry a dead payment job | List jobs, retry a dead job, discard a job |
| Browser-safe errors subpath | A web client wants `isCommandError` | `@arki/journal/errors` with no Drizzle import |
| Public test helpers | A fourth adopter | Export the fixture in `test-support.ts` |
| Versioned event payloads with upcasters | The first incompatible change to an existing event | `schema_version` column with default 1, plus an upcaster per event. Until then: new meaning, new event type |

### 8.3 Never

Each of these was proposed in the brief. Both reviewers said no, for the
reasons given.

- **A mandatory tenant column.** The identity of an event is
  `kind + entity_id + version`, and entity ids are globally unique. A
  tenant column would force every app, most of them single-tenant, to carry
  it, and it would change the unique constraint. Tenant-local ids would
  break the id uniqueness that replay and repair rely on. A tenant belongs
  in `meta` and on the entity row. An index on `meta->>'tenantId'` can come
  later without touching the model.
- **Snapshots.** The entity row is the snapshot, rebuilt on every write.
  Reads never replay. Replay exists for verify and repair, and nobody has
  measured a history long enough to make it slow. A snapshot table would be
  a second copy of the row with its own drift. If a measurement ever shows
  the need, a snapshot table is additive.
- **A multi-entity batch API.** One transaction already holds any number of
  writes, run one after another, and a command can run child commands on
  their own savepoints (`command.ts:49`, checked). A batch abstraction
  would duplicate the savepoint stack and give a second way to do the same
  thing.
- **Runtime-attached handlers.** A job row names its effect by a string. A
  worker in another process that never saw a handler attached at runtime
  leaves the job pending forever, and `strandedJobs` would report it as a
  rename. The catalog that lists effects would be false. Rolling deploys
  assume the set of effects is fixed per build. The thing that comes and
  goes at runtime is a connection, not a handler; connections belong in an
  app hub fed by one static effect, which is what Games Platform does
  today.
- **Renaming to `bus`, `event bus`, `event store` or `event log`.** See
  8.0. Each of those promises something the package does not do: routing,
  runtime subscription, a storage backend without state maintenance, or a
  diagnostic log.
- **Storing commands, rpc calls, cron ticks, log lines or spans as events.**
  Already decided in section 1, item 3. Only a fact about business data is
  a journal event.

### 8.4 Order of work

1. Item 5, gap detection. Smallest, pure correctness, unblocks trust in
   replay for the rest.
2. Item 1, commit order. One lock call and one Postgres test.
3. Item 2, ids. Columns, stamping, migrations in the four owners.
4. Item 4, adopt. Needed by Kapodopera before its next table moves.
5. Item 3, forget. Needs item 4's reserved-type rule and item 5's gap check.
6. Item 6, hooks. Last, because items 2 and 3 add context fields the hooks
   expose.

One commit and one changeset per item. Items 2 and 3 are the only schema
changes; both are additive nullable columns. `@arki/journal` stays 0.x, so
each is a minor changeset.
