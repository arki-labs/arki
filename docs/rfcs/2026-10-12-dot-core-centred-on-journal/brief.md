# Brief: a simpler core for Arki, centred on the journal

You are one of two independent architects working from this same brief. You do
not see the other's work. Do not read any `proposal-*.md` or `synthesis*.md`
file in this folder.

Repo: `/Users/afurculita/Developer/workspace` (Bun + Turborepo monorepo,
TypeScript strict, about 40 apps under `apps/`, about 50 shared `@arki/*`
libraries under `packages/`). Date: 2026-10-12.

## The founder's request, in his words

> db, rpc, queues, crons (@arki/schedule), telemetry (based on opentelemetry),
> logs (@arki/log), with the center around @arki/journal should be the core
> things for Arki Dot. [...] come up with a better, simpler architecture and
> structure for all these libs, and then a simpler integration into Dot moving
> all these at the core of the framework, but with an easy way to configure,
> overwrite things from them. Everything should be event based, and plugins
> should be able to connect to them and change things as they want.

Your job: analyse the current code deeply, then propose that architecture.
This is a design, not an implementation. Change no source file.

You are a peer, not a yes-man. Where the request is wrong, costly, or would
make things less simple, say so and propose what to do instead. "Everything is
event based" in particular deserves a hard look: say exactly what should be an
event, what should not, and why.

## What is known (verified on 2026-10-12 unless marked "lead")

| Piece | Package | Size (src) | Notes |
|---|---|---|---|
| Framework kernel | `packages/dot` 0.4.1 | 43 files, 11k lines | Plugins with typed `needs`/provides, tokens, lifecycle boot/start/stop/dispose, CLI (`dot explain`). Depends on `@arki/log`, `@opentelemetry/api`. Docs in `packages/dot/docs/` (read `principles.md`, `composition-doctrine.md`, `adapter-authoring.md`, `plugin-authoring.md`, `observability.md`). |
| Feature authoring | `packages/feature` 0.0.2 | 4 files, 488 lines | `defineFeature`, `composeRouter`, `composeRepos`, slice contracts. |
| Event log | `packages/journal` 0.1.0 | 33 files, 7.6k lines | Hybrid event log for Drizzle: commands, entities, effects, a worker. Exports `.`, `./pg`, `./dot`, `./orpc`. Design spec: `packages/journal/docs/specs/2026-10-09-journal-design.md`. New (first commit this month). Apps are being moved onto it right now. |
| Older event sourcing | `packages/event-sourcing` 0.2.3 | — | Lead: the journal is replacing it. Check who still uses it. |
| Database | `packages/db` 0.1.9 | 23 files, 1.8k lines | Drizzle. Many subpath exports. |
| Queues | `packages/queue` 2.0.2 | 35 files, 10k lines | BullMQ + ioredis, tRPC-style builder, `runtime-local`. |
| Crons | `packages/schedule` 0.0.1 | 6 files, 1k lines | croner, a lock in `src/runtime.ts`. |
| Logs | `packages/log` 0.0.3 | 9 files, 771 lines | pino, reads `process.env` when imported. No Dot adapter. |
| Telemetry | `packages/meter` 0.1.1 | 9 files, 824 lines | Mixes browser analytics (Plausible, Clarity, OpenPanel, Sentry) with the server OpenTelemetry setup (`./otel`, `./otel/register`). No Dot adapter. Lead: only 3 apps import `otel/register`. |
| RPC | no `@arki/rpc` package | — | Apps use oRPC directly. `@arki/http` has an rpc mount. `packages/journal/src/orpc.ts`, `packages/tanstack-start` and `packages/offline` import `@orpc/server`. |
| HTTP | `packages/http` 0.0.4 | — | Hono inside, route contracts, Dot adapter. |
| Key-value | `packages/kv` 0.1.7 | 8 files | ioredis. |

Each of journal, db, queue, schedule, kv, http, event-sourcing, auth, env and
feature has a Dot adapter at `packages/<name>/src/dot.ts`. Log and meter have
none.

Other pointers:

- Design history: `docs/rfcs/2026-07-0*.md` (six RFCs on Dot, feature
  plugins, transport-agnostic actions, the client contract surface).
- A package audit from 2026-10-09: `plans/packages/README.md`. It holds
  not-yet-executed plans that touch this area: 004, 007 and 010 rebuild
  `@arki/log` as a zero-dependency core with an opt-in Node part; 009 fixes
  lock error handling in `@arki/schedule`. Your design may keep, change or
  replace them. Say which.
- The app template every new app starts from:
  `turbo/generators/templates/application/`.
- Lead: few apps actually boot through Dot today (novelette is the proving
  ground). Measure real adoption of Dot, of the journal, and of each library.
  A design nobody can migrate to is not a simpler design.

## Rules the design must respect

- No `any`, no `@ts-ignore`, no unsafe casts. Typing strength outranks
  generality (founder rule). Prefer inferred types over hand-written ones.
- Importing a declaration-layer module must have no effect: no env read, no
  I/O, no throw. Only `boot()` is effectful (`composition-doctrine.md`).
- "If it does not need boot, it does not need a plugin."
- Shared libraries should run in Node, Bun, Deno, browsers and React Native
  where that makes sense, with few or no dependencies. `packages/math` is the
  exemplar (lint guard plus a `test:runtimes` script).
- Minimum code that solves the problem. No speculative abstraction. If a
  senior engineer would call it overcomplicated, simplify.
- Several of these packages are published on npm. Breaking changes are
  allowed. Name each one.

## Working rules

- Read only. Another session is editing `packages/journal` and several apps
  right now, so the working tree has uncommitted changes. Read the working
  tree as it is. Never run git commands that write, never stash, never install.
- Never print a secret value. Give `file:line` and the credential type only.
- Search traps: exclude `packages/text/dictionary` and
  `packages/text/dictionaries` from any recursive search (414 MB, greps hang).
  Exclude `node_modules` and `dist`. `rg` may be missing in bash; use `grep -rE`.
- Every claim about current code needs a `file:line`. Mark anything you did
  not open yourself as "not verified".
- Budget: aim for about 50 tool calls. Batch reads. Read large files by
  range, not whole.

## What to deliver

One markdown document, in simple everyday English. Short sentences. One idea
per sentence. No jargon shorthand. Aim for under 600 lines. Use these
sections, in this order:

1. **Verdict in ten lines.** The shape you propose and the one thing you
   would not do.
2. **Current state.** For each piece: what it does, what it depends on, how
   it plugs into Dot today, how many apps use it, and how it overlaps with the
   others. Include a dependency picture.
3. **What makes it complicated today.** Ranked. Evidence for each.
4. **Target structure.** The package list after the change: what merges,
   splits, moves, is renamed, or is deleted. Dependency direction between
   them. What "core of the framework" means concretely: which packages Dot
   depends on, and which stay optional.
5. **The event model.** What an event is. Whether there is one mechanism or
   several, and why. How a db write, a command, an rpc call, a queue job, a
   cron tick, a log line and a trace span each relate to the journal. What is
   durable and what is in-memory. Ordering, transactions and failure rules.
6. **The extension model.** How a plugin observes, changes, vetoes or
   replaces behaviour in each core piece. One mechanism if you can. Show the
   types.
7. **Configuration.** Defaults that work with zero config, and how an app
   overrides one thing without restating the rest.
8. **What the app author writes.** A complete small app before and after
   (app file, one feature, one job, one cron, one rpc procedure). Then three
   plugins: one that adds a field to every log line, one that wraps every
   command, one that stops a cron run. Real TypeScript that would type-check
   under the rules above.
9. **Where you say no.** The parts of the request you would not build, with
   the cost of building them anyway.
10. **Migration.** Stages that each ship on their own. Effort and risk per
    stage. What breaks for published consumers. What happens to the existing
    plans 004, 007, 009 and 010.
11. **Decisions for the founder.** At most five. Each with options, the real
    trade-off, and your recommendation.
12. **Not examined.** What you did not look at.

CONTEXT ECONOMICS — COST DISCIPLINE IS YOUR #1 OPERATING PRIORITY: it decides HOW you work, never whether quality gates run. Cost ≈ context size × turn count; every tool round-trip re-processes your whole transcript. Batch independent tool calls into ONE message; combine related shell commands into ONE Bash call. Never re-read a file already in your context (screenshots/images included — a re-read bills again on every later turn). Read large files with Grep or offset+limit, never whole. Broad exploration goes to an Explore subagent whose exhaust dies with it, not into your transcript. Do the task, return the structured report, stop. If you noticed a concretely cheaper way this work could have been structured, end your report with ONE line: `COST NOTE: {observation → suggested change}` — most tasks produce none; never invent one.
