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
| 0 | Fix the template server: remove the Kapodopera imports. | Small | Low |
| 1 | Repair the journal worker (faults 1-3, DONE 2026-10-12) and the schedule lock outcome (plan 009, open). | Medium | High on correctness, few users today |
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
| 4 | What a cron promises | **Each cron chooses.** `defineSchedule({ ..., durable: true })` is backed by a BullMQ repeatable job; the default (`durable: false`) runs in process and skips ticks missed while down. A durable cron with no queue plugin fails boot with a coded error. | `@arki/schedule` gains a durable mode that hands the cron to `@arki/queue`. The queue's cron support stays: it becomes that backend. |
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
