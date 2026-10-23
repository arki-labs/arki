# Schedules in a Dot app

Reference for `@arki/schedule/dot`: `schedules()`, `schedule()`, locks, the host clock, the `scheduler` service and oRPC cron routes.

## Inside a DOT app

A feature declares its schedules with `schedules([...])`. `schedule()` is an
entrypoint: mount it with `.entrypoints()`, after the features. It runs the
schedules of every mounted feature — the app lists its features once:

```ts skip="excerpt: it uses names this page does not define"
import { defineFeature } from '@arki/dot/feature';
import { initSchedule } from '@arki/schedule';
import { schedule, schedules } from '@arki/schedule/dot';

type Ctx = { readonly db: Db };
const s = initSchedule.context<Ctx>().create();

export const reports = defineFeature('reports').entrypoints(
  schedules([s.define({ name: 'daily-report', cron: '0 6 * * *', handler: async ({ db }) => db.reports.build() })]),
);

defineApp('shop')
  .infra(db({ url }))
  .features([reports, billing])
  .entrypoints(schedule({ needs: { db: database.provides.db }, context: ({ db }) => ({ db }) }));
```

`context` builds the one value every handler receives. The features are
bound at runtime, so the compiler cannot check that their schedules expect
this context: keep one context type per app. A schedule no feature owns
goes in `schedule({ schedules: [...] })`; it runs on the same runtime, so
names must be unique across both.

### Schedules that use the feature: `schedules(core, defs)`

A feature lists its schedules in `.entrypoints(...)`. Pass the core, and
each handler gets what every entrypoint of the feature gets — its needs, its
private infra and `usecases` — typed with no annotation. The schedules file
takes the core as a parameter (`import type`), so it never imports the
feature at runtime:

```ts skip="excerpt: it uses names this page does not define"
// features/daily-digest/entrypoints/schedules.ts
import type { core } from '../feature';

export const digestSchedules = (c: typeof core) =>
  schedules(c, [{ name: 'send-digest', cron: '*/15 * * * *', handler: ({ usecases }) => usecases.sendDue() }]);

// features/daily-digest/feature.ts
export const dailyDigest = core.entrypoints(digestSchedules(core));
```

A key the feature does not have (`({ db }) => …` when only its store needs
`db`) is a compile error. Same options and rules as below. Cron still decides
_when_; the core decides _with what_.

### One replica at a time: `lock`

```ts skip="excerpt: it uses names this page does not define"
import { locks } from '@arki/lock/dot';
import { pgLease } from '@arki/lock/pg/lease';

// Once, in the app: the `locks` service that locked schedules read.
defineApp('shop').infra(
  locks({
    namespace: 'shop',
    needs: { db: database.provides.db },
    store: ({ db }) => pgLease(db, { ttl: '30s' }),
  }),
);

// The feature needs `locks`, like any other service.
const core = defineFeature('clustering').needs({ locks: service<Locker>() }).usecases({ assign });

schedules(core, [
  { name: 'cluster-assign', cron: '*/5 * * * *', lock: true, handler: ({ usecases }) => usecases.assign() },
  {
    name: 'cluster-batch',
    cron: '0 */4 * * *',
    lock: { key: 'clusters', holdAtLeast: '5s' },
    handler: ({ usecases }, run) => usecases.recluster({ signal: run.lock?.signal }),
  },
]);
```

- `lock` takes `true | string | { key?, holdAtLeast? }`. `true` locks on the
  schedule name. A string, or `key`, locks on that key (give two jobs the same
  key to make them exclude each other).
- The lock comes from the feature's `locks` service, typed by the small
  `Locker` port: `mutex(key).tryRun(fn, { holdAtLeast })` returns the value
  of `fn`, or the `lock.held` failure when another holder has the key.
  `locks()` from `@arki/lock/dot` provides it, and so does the `Locks` that
  `createLocks` returns. A schedule with `lock` and no `locks` service is a
  compile error (and
  `ARKI_SCHEDULE_E009` at boot for code that skips the types).
- On SQLite, the store is `sqliteLease(db, { ttl: '30s' })` from
  `@arki/lock/sqlite`, with the `db` from `createLibsqlDb`. Schedulers that
  share the database file run each tick once.
- The lock is held while the handler runs, not for a fixed time. There is no
  key-value lease any more: that path is gone.
- `holdAtLeast` defaults to `1s`. The lock stays held at least that long after
  the job started, so a replica with a slow clock cannot start a sub-second
  job again. `holdAtLeast: 0` turns it off. `trigger()` and the shutdown drain
  wait for the release, so a locked run takes at least 1 s.
- The handler's second argument has `run.lock`: `{ signal, fence }`. `signal`
  aborts when the lock is known lost, so a long job can stop. `fence` is the
  store's fencing token, or `undefined` when the store has none.
- A run that finds the lock held reports `skipped-lock` and the handler never
  starts. A lock that cannot be taken reports `lock-failed`. A handler that
  throws inside the lock is still `handler-failed`. A lock lost after the
  handler finished (during the hold) keeps the handler's result, counts in
  `lockLost` and logs a warning.
- A failed release after a good run is not a schedule result. `@arki/lock`
  logs it and counts it in `Locks.counters.releaseErrors`.
- The policy is in the manifest. `dot explain` shows `lock <key>`, or
  `NO LOCK` for an unlocked schedule. After boot, `dot doctor` shows the full
  line: `lock <ns>:<key>  [<store> · <kind> · <scope> · crash→<bound> · fence <level> · hold≥1s]`.
  `overlap: 'skip'` still guards the process itself.

### Feature-owned schedules: `schedules(core, defs)`

When a schedule belongs to one feature and works with that feature's
services, declare it with the feature's core. The handler's parameter is
typed from the core with no annotation. The entrypoint's `context` is not
used for these handlers.

```ts skip="excerpt: it uses names this page does not define"
const core = defineFeature('digest').needs({ mailer: service<Mailer>() });

export const digest = core.entrypoints(
  schedules(core, [
    // Plain option objects, not defineSchedule(): the handler is typed from the core.
    { name: 'send-digest', cron: '0 7 * * *', handler: ({ mailer }) => mailer.sendDigest() },
  ]),
);
```

The options and validation match `defineSchedule` (`cron` or `every`,
`timezone`, `overlap`), except `durable: true`: a durable run happens in
another process that does not hold these services. It is a type error and
fails at declaration with `ARKI_SCHEDULE_E006`. The handler may return a
value; a `ran` result keeps it.

Every run of a Dot schedule also emits handler events (`starting`, then
`completed` or `failed`), owned by the feature that declared it (`schedule`
for app-level schedules). A returned failure, such as a `with` step refusal,
is `completed` with outcome `refused`; a throw is `failed`. Turn them into
logs and error reports with `logHandlers()` and `reportErrors()` from
`@arki/dot`. The events only watch: the run result is unchanged.

### The host clock: `schedule({ clock: 'host' })`

By default (`clock: 'internal'`) the runtime fires schedules on its own
timers. With `clock: 'host'`, `start()` arms nothing: a schedule runs only
when the host calls `trigger` (a platform cron, an HTTP endpoint). A durable
schedule or a durable backend with the host clock fails boot with
`ARKI_SCHEDULE_E007`, because two clocks would fire the same tick.

### The `scheduler` service

`schedule()` provides `scheduler` to the app, typed with no annotation:

```ts skip="excerpt: it uses names this page does not define"
const app = await defineApp('news')
  .infra(mailer())
  .features([digest])
  .entrypoints(schedule({ clock: 'host' }))
  .boot();

app.services.scheduler.clock; // 'host'
app.services.scheduler.names; // ['send-digest']
await app.services.scheduler.trigger('send-digest');
```

`trigger(name)` resolves a `ScheduleOutcome`: a run result (see
[Run results](#run-results)), or `unknown` for a name the entrypoint does not
run. A trigger works once the app has booted, before `start()` too. After
`stop()` it reports `unavailable`; `stop()` waits for runs it already
accepted.

### Typed triggers: `composeSchedules(features, scheduler)`

`composeSchedules` turns the service into a client typed from the features'
own `schedules(core, defs)` declarations. An undeclared name is a compile
error, and a `ran` outcome's `value` is that handler's resolved return type:

```ts skip="excerpt: it uses names this page does not define"
const schedules = composeSchedules([digest], app.services.scheduler);
const outcome = await schedules.trigger('send-digest');
if (outcome.status === 'ran') outcome.value; // the type sendDigest() resolves to
```

It throws `ARKI_SCHEDULE_E008` when the scheduler does not run a declared
schedule (pass the same features the app mounts).

### Cron routes over oRPC: `@arki/schedule/orpc`

When an outside clock (Coolify, a cron job) fires schedules over HTTP,
`@arki/schedule/orpc` serves them as one oRPC contract: `POST /<name>`
triggers the schedule `<name>`. You write the name and its 200 body schema;
the method, the path and the dispatch are fixed. What each outcome answers
is your policy. Needs the optional peers `@orpc/contract` and `@orpc/server`.

```ts skip="excerpt: it uses names this page does not define"
// server-only
const cronContract = defineCronContract({ 'send-digest': digestRunSchema });
const cronImplementer = implement(cronContract).$context<CronContext>().use(cronSecret); // your auth
export const crons = cronRouterFor(cronImplementer, cronContract, features, {
  respond: {}, // required for a cron whose run value is not exactly its body
  skipped: () => skipped(), // overlap or held lock → the cron's lock-held body (200)
  failed: (_name, cause) => rethrow(cause), // leave oRPC; your route's 500 boundary answers
  unavailable: () => fail(503, { error: 'schedule unavailable' }),
});

// the route
const handler = new OpenAPIHandler(crons, { customErrorResponseBodyEncoder: cronErrorBody });
const carry: CronContext['carry'] = {};
const { matched, response } = await handler.handle(request, {
  prefix: '/api/cron',
  context: { headers, schedules, carry },
});
if (carry.rethrow) throw carry.rethrow.cause;
```

What it checks at compile time: every name is a schedule of some feature,
and every body schema is exactly the type the run puts on the wire (both
ways), or that cron must say in `respond` how its value maps. A supervised
`UnexpectedDefect` goes to the existing `failed` policy before response mapping;
it never becomes a success body. Declared business refusals keep their explicit
responder mapping. On the wire:

- a run's body is the value as produced — `checkOnly()` checks it but keeps
  the original, so key order is the run's, not the schema's;
- `fail(status, body)` answers exactly `body`, never oRPC's error envelope;
- `skipped()` answers `{ "skipped": "lock-held" }`, or the cron's own legacy
  body (`{ body, skipped: {...} }` in its spec).

No `node:` import, no auth, no logging: it runs on every runtime.
