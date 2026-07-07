# RFC: `queue()` / `auth()` lifecycle pips + `@arki/schedule`

- **Status:** DRAFT — decision C resolved 2026-07-07 (founder: **build the
  small `@arki/schedule` anyway for the Redis-less case**, overriding the
  no-package recommendation); A/B pending, recommendations stand unless
  overridden
- **Date:** 2026-07-07
- **Author:** Claude (session fbbe6be7), distilling item 5 of the 2026-07-04
  "what it takes for `@arki/dot` to beat NestJS" investigation, which until
  this document existed only in conversation history
- **Depends on:** `@arki/dot` 0.3.0, `@arki/queue` `/dot` + `/projection`
  subpaths (shipped by RFC `2026-07-07-dot-transport-agnostic-actions.md`,
  commit f584570e68), `@arki/auth` 0.1.3 (`initAuth`)
- **Related:** `docs/rfcs/2026-07-06-arki-http-adapter-and-request-scope.md`
  (bundle pattern, drain ordering), `docs/rfcs/2026-07-07-arki-event-sourcing-first-class-dot.md`
  (the zero-config env-resolved pip pattern this RFC copies),
  `packages/dot/docs/adapter-authoring.md`
- **Location note:** internal; must NOT move into `packages/dot/docs/`
  (that tree mirrors to the public `arki-labs/arki` repo).

## Summary

The investigation's item 5, verbatim:

> **Promote existing packages as pips.** `@arki/queue` (start/stop worker
> lifecycle — the outbox example in the new README is begging for it),
> `@arki/auth`, and a small `@arki/schedule`. Each closes a named
> `@nestjs/*` module comparison at adapter cost, not kernel cost.

Since that was written, two sibling RFCs (both ACCEPTED 2026-07-07) took
bites out of the scope:

- The **actions RFC** delivered queue's *observability* half:
  `@arki/queue/dot` (job registry → `in`/`out` actions) and
  `@arki/queue/projection` (`--as queue-topology`). Novelette's pip already
  declares these.
- The **event-sourcing RFC** established the pattern this RFC copies for
  auth: env-resolved zero-config boot, feature-local contribution, actions
  in the manifest.

What remains — and what this RFC scopes — is the **lifecycle** half:

1. **`queueRuntime()`** — a pip factory in `@arki/queue/dot` that owns the
   worker start/stop discipline apps currently hand-roll
   (novelette's `pips/queue-runtime.ts` is the proven prototype).
   Closes `@nestjs/bullmq`.
2. **`auth()`** — a pip in `@arki/auth/dot` wrapping `initAuth`:
   `needs { db }`, provides the better-auth instance as a service.
   Closes `@nestjs/passport`.
3. **`@arki/schedule`** — a new small package for the **Redis-less case**
   (founder decision C): in-process cron/interval scheduling with a
   `schedule()` pip, honest multi-replica posture (documented single-replica
   default + optional KV-lock guard), and schedule actions in the manifest.
   Closes `@nestjs/schedule`. The Redis-backed path (`q.schedule.cron(...)`
   repeatables) and the platform-cron recipe (Coolify → HTTP POST) remain
   the recommended paths *when their infrastructure exists*.

No kernel changes. All three packages stay `private: true` for now; public
promotion is explicitly out of scope (decision gate lives in
`arki.release.config.ts` Wave 3's "rejoin when they ship dist+docs" note).

## Pip 1 — `queueRuntime()` in `@arki/queue/dot`

### Current state

- `@arki/queue` (private, 2.0.2) is builder-shaped (`initQueue`, tRPC-style
  context/middleware, jobs/schedules/flows). Worker runtime start/stop is
  **app code** — novelette's `startQueueRuntime`/`stopQueueRuntime` live in
  `@novelette/backend/jobs`, not in the package.
- Novelette's `apps/novelette/server/src/pips/queue-runtime.ts` is the
  prototype. Its hard-won semantics (all pre-DOT lessons, preserved through
  the http migration):
  - **Non-blocking guarded start.** `start()` fires the runtime without
    awaiting it, racing a 30 s timeout. The http pip (declared after)
    must not wait on Redis; health checks come up immediately.
  - **Assembly inside the guard.** Service assembly (R2 creds, etc.)
    happens inside the guarded race — a missing credential degrades the
    server to HTTP-only instead of failing boot.
  - **Drain ordering for free.** Declared before `http()`, so kernel stop
    order drains HTTP ingress before workers halt.
  - Actions + projection declared via the `/dot` helpers (already generic).

### Proposal

A factory that generalizes exactly the lifecycle discipline and nothing
else — the app keeps owning its runtime assembly:

```ts
// @arki/queue/dot
export function queueRuntime<TNeeds extends ServiceShape>(options: {
  name?: string;                       // default 'queue-runtime'
  needs: TNeeds;                       // e.g. { kv: service<KV>() }
  registry: QueueRegistry;             // jobs object → actions auto-derived
  start: (services: Resolved<TNeeds>) => Promise<QueueRuntimeHandle>;
  startupTimeoutMs?: number;           // default 30_000
  blocking?: boolean;                  // default false — degradation-guarded
}): DotPip;

type QueueRuntimeHandle = { stop(): Promise<void> };
```

The pip's `boot` captures services, `start` runs the guarded race (or
awaits, when `blocking: true`), `stop` calls the handle. `actions` come
from `queueConsumerActions(registry)`/`queueProducerActions(registry)`;
the `queue-topology` projection is registered automatically. Coded errors
per `adapter-authoring.md` (`ARKI_QUEUE_E*`): startup timeout, double
start, stop-before-start.

Exit criterion: novelette deletes `pips/queue-runtime.ts`'s lifecycle
scaffolding and keeps only its `buildRuntimeConfig` assembly — behavior
byte-identical under the four degradation postures (Redis up/down ×
creds present/missing).

## Pip 2 — `auth()` in `@arki/auth/dot`

### Current state

- `initAuth(db, options)` (in `packages/auth/src/dot.config.ts` — note:
  that filename predates `@arki/dot` and refers to better-auth config;
  rename to `better-auth.config.ts` during this work to kill the
  collision) builds the better-auth instance: drizzle adapter, magic-link,
  oAuthProxy, expo, social providers, env-resolved secrets.
- Zero DOT integration. Apps construct auth imperatively and thread it by
  module import.
- The http RFC's Phase 3 already shipped the *consumption* side: the
  session-deriver recipe in `packages/auth/README.md` assumes an `auth`
  service is injectable.

### Proposal

```ts
// @arki/auth/dot
export function auth(options: AuthPipOptions): DotPip;
// needs { db: service<DB>() } → provides { auth: Auth }
```

Boot calls `initAuth(db, options)`; secrets keep resolving from env inside
`initAuth` (same doctrine as the es pip's env-resolved store URL). No
start/stop/dispose — better-auth holds no connections of its own (the db
pip owns the pool). Actions: none in v1 — better-auth's HTTP surface is
mounted through `@arki/http` (`bind.mount`) and described there; a later
revision can project auth routes as actions once the mount story
stabilizes.

Exit criterion: one shipped app boots auth through DOT and serves a
session-derived guarded route via the README recipe (novelette's admin
route or an app already on better-auth).

## Pip 3 — `@arki/schedule` (new package) + `schedule()` pip

**Founder decision C (2026-07-07): build it, for the Redis-less case.**
The original recommendation was no-package (queue repeatables + Coolify
cron cover apps that *have* infrastructure); the founder's call is that
the Redis-less app deserves a first-class in-process answer. The two
existing paths stay documented and preferred when available — this
package is the third leg, not a replacement.

### Positioning (honest about the trade-off)

- **In-process, zero infrastructure.** No Redis, no platform cron, no
  daemon. A Bun/Node process arms its own timers.
- **Multi-replica double-fire is real and stated, not hidden.** Default
  posture: documented single-replica. Opt-in `lock` option takes a KV
  handle (the `@arki/kv` pip is right there) and wraps each fire in a
  TTL lock, making multi-replica deployments safe at
  at-most-once-per-tick semantics. `@nestjs/schedule` ships the same
  in-process model with no lock story at all — this is where the
  comparison is won, in the type system and the docs.

### Package shape

`packages/schedule`, `@arki/schedule`, `private: true` initially
(0.0.x on promotion). Engine: **`croner`** as an internal dependency —
zero-dep, timezone-aware, already in the workspace lockfile (10.0.1,
transitive) — never visible in the public types, same doctrine as Hono
inside `@arki/http`.

```ts
// @arki/schedule — definitions are pure data + a handler
export function defineSchedule(opts: {
  name: string;                        // unique per app; lock key derives from it
  cron?: string;                       // exactly one of cron | every
  every?: `${number}${'s' | 'm' | 'h'}`;
  timezone?: string;
  overlap?: 'skip' | 'concurrent';     // default 'skip' — no pile-ups
  handler: () => Promise<void>;
}): ScheduleDef;

// @arki/schedule/dot
export function schedule(opts: {
  schedules: readonly ScheduleDef[];
  lock?: KvLike;                       // opt-in multi-replica guard (TTL lock per fire)
  jitterMs?: number;                   // de-thundering-herd on 'every' schedules
}): DotPip;
```

Lifecycle: `start` arms timers (never before — a booted-but-not-started
app must not fire), `stop` cancels timers and **awaits in-flight
handlers** (drain, same discipline as http's E005), `dispose` is a
no-op. Coded errors `ARKI_SCHEDULE_E*`: invalid cron expression at
construction (fail at `defineSchedule`, not at 3 a.m.), duplicate
schedule names, handler failure (logged + counted, never crashes the
timer loop), lock-acquire failure (skip + debug log — another replica
fired).

Manifest: each definition is an action — `binding: 'schedule'`,
`direction: 'in'`, `address` = the cron expression or interval,
`meta { kind, cron/every, timezone, overlap, locked }` — plus a
registered `--as schedule-table` projection (`@arki/schedule/projection`)
so `dot explain` renders an app's full recurring surface without booting.

Bundles are deliberately **not** in v1: schedules are app-root concerns
more often than feature-local ones; if feature-local contribution proves
real, the http/es `bundles` pattern layers on without breakage.

## Open questions (founder decisions)

A. **Queue pip shape** — factory wrapping an app-supplied `start` (the
   proposal — preserves novelette's assembly-inside-guard lesson) vs. full
   inversion where `@arki/queue` owns worker construction from the
   registry (bigger, touches the builder API, not needed by any app
   today). Recommended: factory.
B. **Auth pip surface** — provide only `{ auth }` (recommended: smallest
   credible v1; consumers derive sessions via the README recipe) vs. also
   providing pre-built derivers/route bundles for `@arki/http` (couples
   auth to http; can layer on later without breakage).
C. **Schedule** — ~~no new package (recommended) vs. build small
   `@arki/schedule` anyway for the Redis-less case~~ — **RESOLVED
   2026-07-07: build it** (founder override; design in Pip 3 above).

## Delivery plan

| Phase | Contents | Exit criterion | Status |
| --- | --- | --- | --- |
| 1 | `queueRuntime()` factory in `@arki/queue/dot` + tests (guarded start, timeout, degradation, stop, action derivation) | novelette's pip reduced to assembly-only; four degradation postures verified live | — |
| 2 | `auth()` pip in `@arki/auth/dot` + `dot.config.ts` → `better-auth.config.ts` rename + tests | one shipped app boots auth through DOT; guarded session route live | — |
| 3 | `packages/schedule`: `defineSchedule` + `schedule()` pip + `/projection` (`--as schedule-table`) + KV-lock guard + tests (arm/drain, overlap skip, lock contention, invalid-cron fail-fast) | one shipped app runs a real recurring task through `schedule()`; `dot explain --as schedule-table` renders it; queue-repeatable + Coolify paths documented alongside | — |
| 4 | *(conditional, separate work)* public promotion of `@arki/queue`/`@arki/auth`/`@arki/schedule` per `add-new-package.md` | scorecard OPEN | queue/auth blocked on the packages themselves (dist+docs, `private` flip); schedule is new so it only needs the standard promotion pass |

Phase 4 watch point: all three packages peer-depend on `@arki/dot` once
they carry pips, so they join the peer-major-bump cascade — every
non-patch dot release will 1.0.0-bump them under changesets until
corrected via Path B (see `.changeset/README.md`).

## Non-goals

- Kernel changes of any kind — both pips are pure adapters.
- Publishing/promotion (Phase 4 is a pointer, not scope).
- Replacing app-level job/handler definitions — feature code keeps owning
  jobs; the pips own lifecycle and manifest visibility.
- WebSockets/microservices transports (explicitly out of scope in the
  investigation's gap matrix).
