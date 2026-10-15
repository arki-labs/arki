# RFC: Dot feature builder — cron routes as one contract

- **Status**: Accepted (Revision 1, founder-approved 2026-10-15).
- **Parent**: [`2026-10-15-dot-feature-builder.md`](./2026-10-15-dot-feature-builder.md)
- **Authors**: Fable (design), Astra (review), founder (decisions).
- **Sources**: the design file, copied from the session scratchpad so it outlives it. Revision 0 is summarized at the end; Revision 1 is the design.

---

## Naming (Rule 6)

Founder-approved 2026-10-15. Text below the table keeps old names in places.

| Old | New | Why |
| --- | --- | --- |
| `@arki/schedule/orpc` `cronContract()` | `defineCronContract()` | A library function must not share a name with the app's `cronContract` value. |
| `cronRouter()` | `cronRouterFor()` | Same; reads like `routerFor`. |
| `validated()` | `checkOnly()` | Says what it does: checks, returns the ORIGINAL value (key order kept for byte parity). |
| feature `pushCron` | `pushCronSpecs` | It is the cron specs (name -> body schema), not a cron. |
| app builder `os` | `cronImplementer` | Pairs with `rpcImplementer`. |
| stage `core` | `<feature>Logic` | See the parent RFC. |
| kept | `CronContext`, `CronSpecs`, `backend/src/cron.ts` (`cronContract`, `cronRouter`) | Already clear. |

---

## Revision 1 (2026-10-15) — after Astra's review; supersedes Revision 0 below

Every finding was checked in the code before it was adopted. All 8 are in. Byte-identical now means status, body text (key order included), content-type, auth-before-boot, and who reports what.

The design was proven in a throwaway probe before implementation:
- `tsc -p tsconfig.json` exit 0. Five `@ts-expect-error` lines; dropping any one gives exactly one error.
- `node out/test/main.js`: **old routes 70/70, new mount 70/70, 0 mismatches**, text compared, not parsed JSON. 7 names × {ran fixtures, ran + stray malformed body, skipped-overlap, skipped-lock, handler-failed, lock-failed, unavailable, boot fails, no header, not bearer, wrong secret}. Three deliberate mutations (route removed, status changed, body key renamed) each make the inventory fail.
- `tsc -p tsconfig.client.json --listFilesOnly`: `src/app/contract.ts`, `src/client.ts`. Nothing else.

### What changed from Revision 0

| Rev 0 | Rev 1 |
| --- | --- |
| 500/503 bodies become oRPC's envelope | Never. Every reply is the legacy text. The envelope cannot reach Coolify. |
| 200 bodies "JSON-equal", keys in schema order | Bytes equal. `checkOnly()` checks the body but returns the original value. |
| Three value-based 500s: use cases throw | Kept as explicit `respond` mappings (their tests read those bodies). |
| One-way `extends` type check | Two-way. A schema that drops or invents a key is a compile error. |
| `rethrow cause` inside oRPC | The cause leaves oRPC; the overlay answers the same HTML 500 and reports to Sentry, as today. |
| `cronSecret` in the package, `!==` | Stays in the app (`core/orpc.ts`), sha256 + `timingSafeEqual`. |
| Body parsed by oRPC | The route hands oRPC a body-less request. `{` with valid auth still runs. |
| Parity test invented later | Frozen 32-URL inventory written before any deletion. |

### Shape

```
Coolify ──POST /api/cron/<name>──▶ routes/api/cron/$.ts               (POST only; GET/HEAD/OPTIONS fall through to SSR as today)
   verifyCronSecret(request)        → 401 texts, before boot          (unchanged file)
   schedules = await getSchedules() → boot failure throws here → overlay HTML 500 + Sentry (as today)
   OpenAPIHandler(cronRouter, { customErrorResponseBodyEncoder: cronErrorBody })
       .handle(bodyless(request), { prefix: '/api/cron', context: { headers, schedules, carry } })
   if (carry.rethrow) throw cause   → overlay HTML 500 + Sentry (as today)
                 │
backend/src/cron.ts (server-only)    defineCronContract({ ...companionCron, ...pushCronSpecs, … })
                                     cronRouterFor(cronImplementer, cronContract, features, avocaboPolicy)
feature/entrypoints/cron.ts          export const pushCronSpecs = { 'push-breaking': breakingRunSchema }
feature.ts                           schedules(pushLogic, [...])   (unchanged)
```

### Package: `@arki/schedule/orpc` — machinery only (probe `pkg/cron-orpc.ts`, 179 lines)

- `defineCronContract(specs)`: per name `oc.route({ method: 'POST', path: '/<name>', outputStructure: 'detailed' }).output(checkOnly({ status, body: run ∪ skipped }))`. Spec = body schema, or `{ body, skipped }` for a legacy lock-held body (kept as procedure meta).
- `checkOnly(schema)`: a Standard Schema that validates with `schema` and returns the **original** value. oRPC replaces the output with what the schema returns; zod rebuilds objects in schema order and strips keys. The wire must carry the value as produced.
- Replies: `ok(body)`, `fail(status, body)`, `rethrow(cause)`, `skipped()`. `Ok<T>` is invariant (type-only marker), so `ok({ ...body, extra })` is not an `Ok<Body>`.
- `cronRouterFor(implementer, contract, features, policy)`: `implementer` is the app's implementer with the app's middlewares. Compile checks: every name is a schedule of some feature; `policy.respond[name]` is **required** for every cron whose schedule value is not exactly its body schema (two-way), optional otherwise. Dispatch: `ran` → `respond ?? ok(value)`; skipped → `policy.skipped`; failed → `policy.failed`; unavailable/unknown → `policy.unavailable`.
- Sending: `Ok` → detailed 200; `Skipped` → the cron's skipped body; `Fail` → `ORPCError({ status, data: body })`, and `cronErrorBody = e => e.data` makes the body exactly `data`; `Rethrow` → `context.carry.rethrow = { cause }`, then throw (the response is discarded by the route).
- `CronContext = { headers, schedules, carry }`. No `node:crypto`, no auth, no logging: cross-runtime clean. Dailycanvas-style query inputs become a later optional `input` on the spec (`inputStructure: 'detailed'`); not built now.

### App policy: Avocabo (probe `app/cron.ts`, 46 lines)

```ts
const cronImplementer = implement(cronContract).$context<CronContext>().use(cronSecret);   // core/orpc.ts, base narrowed to { headers }
export const cronRouter = cronRouterFor(cronImplementer, cronContract, features, {
  respond: {
    'compute-merged-summary':   v => (v.aborted ? fail(500, v) : ok(v)),
    'retention-maintenance':    v => (v.ok ? ok(v.body) : fail(500, { error: v.error })),
    'summarization-cost-alert': v => (v.status === 'checked' ? ok(v.result) : fail(500, { error: 'Cost alert check failed' })),
    'reconcile-vectors':        v => (v.ran ? ok(v.result) : skipped()),
  },
  skipped: () => skipped(),
  failed: (_name, cause) => rethrow(cause),
  unavailable: name => { log.error('Cron schedule is not available', { schedule: name }); return fail(503, { error: 'schedule unavailable' }); },
});
```
`process-items` keeps `{ skipped: true, reason: 'lock-held' }` in its spec. Sentry: only the overlay reports (handler-failed, lock-failed, boot), with its tags; 503 logs only; `onError` is not used (it would double-report).

### Byte identity, path by path (all proven in the probe)

| Path | Today | New | Text equal |
| --- | --- | --- | --- |
| 200 value | `Response.json(value)` | detailed output through `checkOnly()` | yes, key order kept (process-items schema keys are in a different order on purpose) |
| 200 lock-held | `{"skipped":"lock-held"}` / process-items body | `skipped()` → meta body | yes |
| 401 ×3 | `verifyCronSecret` | same function, same place | yes, and `getSchedules` not called |
| 500 from a value (3 crons) | `Response.json(x, {status:500})` | `fail(500, x)` → `ORPCError` + `cronErrorBody` | yes |
| 500 failed run / lock failed / boot | thrown → overlay `text/html` + Sentry | thrown (carry) or thrown before oRPC → same overlay | yes |
| 503 | `{"error":"schedule unavailable"}` + `log.error` | `fail(503, …)` + `log.error` | yes |
| stray malformed body | ignored | body-less request | yes |
| unknown name | no file route → SSR fall-through | splat answers 404 only for names outside the contract, after the static files win | n/a |

One path still shows the envelope: output validation failure (`{"code":"INTERNAL_SERVER_ERROR",…"Output validation failed"}`), which is a bug by construction — the two-way type check and the inventory both catch it before it ships (mutation C).

### Locks

`lock: true` needs a `locks` service on the feature (`dot.ts:226`). Each converting feature that uses `withCronLock` adds `advisoryLocks(database.provides.db, { namespace: APP_KEY })` to its `.infra()` — same `hashtext('<ns>:<key>')`, pinned transaction, `idle_in_transaction_session_timeout = 0`, unlock in `finally`. Crons that lock around the whole body (send-digest, cluster-*, compute-embeddings, inbound-canary, reconciliation-alerts, search-index, process-items) move to `lock: true`; `skipped-lock` then answers the same 200 body. **reconcile-vectors keeps the lock inside the use case** (`locks.tryRun` after the provider check), so the not-configured body stays and the value stays lock-shaped; its `respond` above maps it. One difference, not on the wire: `withCronLock` also captured the error itself, so a failed locked run reaches Sentry twice today; with `advisoryLocks` it reaches Sentry once, through the overlay. Flagged, not preserved.

### The frozen inventory (probe `test/inventory.ts`)

`start/src/routes/api/cron/-inventory.ts` (the `-` keeps it out of the router), committed in batch 2's **first** commit, before any route file is deleted. For each of the 32 names: one or more `ran` fixtures typed `ScheduleValueOf<Features, N>` (a fixture cannot miss a required key), and the expected status + exact text + content-type as literals, taken from the route file and its test. Shared cases per name: stray body, overlap, lock, handler-failed, lock-failed, unavailable, boot failure, three auth failures (with "schedules never built").

`cron-parity.test.ts` runs the inventory against **both** every remaining `cron/<name>.ts` `handlePost` and the splat handler, both behind `withServerErrorOverlay`. Proven to fail on: a name removed from the contract (404 ≠ text), a status change, a body key renamed. The e2e `cron.spec.ts` stays (it asserts `< 500` after auth; it never accepted 404 for a converted route since the splat still serves it). When the last file goes, the old half of the test goes.

### Migration (unchanged, one step added)

Batch 2: package entry, `cron.ts`, splat route, `contractMounts += 'cron/$.ts'`, inventory (first commit), parity test; convert `companion-gate` and `push-breaking`. Batches 3–6, in each feature's commit: `entrypoints/cron.ts`, spread into `cron.ts`, `advisoryLocks` + `lock: true` where `withCronLock` was, `respond` entry if the value is not the body, delete route file + test + exemption line, fixtures into the inventory. Template: `cron.ts` (empty specs, default policy), the splat, `-inventory.ts` skeleton, the parity test, `contractMounts` entry. Catalog: `@orpc/openapi` (start dep only). `@arki/dot`: nothing.

### Rejected from the review, and why

- "Compatibility interceptor" rewriting responses: not needed. oRPC's own `customErrorResponseBodyEncoder` makes an error's body exactly the policy's body, with no response parsing.
- "Normalize failed outcomes to internal errors": that would answer JSON 500 where today answers the overlay's HTML 500. The cause leaves oRPC instead, so the same boundary answers and reports.
- Everything else adopted.

---

## Revision 0 (superseded)

Rev 0 let error bodies (500/503) become oRPC's JSON envelope. It compared 200 bodies as parsed JSON, with keys in schema order.
It moved `cronSecret` into the package. Three crons threw an error instead of answering 500 from a value.
It was superseded because the review found these change bytes on the wire (body text, key order, HTML 500 from the error overlay, Sentry reporting), so Revision 1 keeps every response byte-identical.
