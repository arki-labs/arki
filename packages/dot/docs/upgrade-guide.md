# Upgrade Guide

`@arki/dot` v0.1 is the first public release. The pre-0.1 legacy surface
(`createDot`, `definePlugin`, the `@arki/dot/legacy/*` barrel,
`@arki/dot/event-sourcing`, and `@arki/dot/presets/runtime-local`) is **not
shipped** in v0.1. Use `defineApp` / `plugin` for composition. For
event-sourced writes use `@arki/journal`: its `@arki/journal/dot` plugin
`journal(...)` and feature slice `journalHandlers(...)` replace the old
event-sourcing helpers.

Future breaking changes will be documented here, version by version, with:

- A summary of what changed and why.
- Concrete before/after code.
- A codemod where automation is possible.
- A pointer to the relevant `CHANGELOG.md` entries.

## Plugin provides

Plugins publish through `provides`: one factory per key. `boot` is side
effects only, and returning a value from it is a compile error.

- Before: `plugin({ name: 'db', boot: () => ({ db: openDb() }) })`
- After: `plugin({ name: 'db', provides: { db: () => openDb() } })`
- Before: `async boot({ db }) { return { billing: new Billing(db) } }`
- After: `provides: { billing: ({ db }) => new Billing(db) }`

If the old `boot` had side effects and a return, move the value into a
factory and keep the side effects in a void `boot`. Factories get the needs
plus `$app`, `$plugin` and `$config`, and may be async (awaited in key order).

Other changes in the same release:

- Every plugin has typed handles: `needs: { db: database.provides.db }`
  replaces `service<Db>()` where the provider can be imported. Use
  `.lazy` on a handle for a `Lazy<T>`. Name the type once:
  `export type Db = Provided<typeof database.provides.db>`.
- `rename(p, { db: 'reportsDb' }, 'reports-db')` rebuilds handles: use
  `reportsDb.provides.reportsDb`.
- A provider mounted after its consumer is `DOT_LIFECYCLE_E020` at
  `configure()`; a ring is `E019`. `E012` is now only for needs no plugin
  declares.
- `providesOf([...])` accepts plugins as well as features.
- New `fake(handle, value)` in `@arki/dot/test-harness`.
- Handles carry the provider's name in the type (`database.provides.db.provider`
  is `'database'`), and the feature builder reads it: a need bound to one
  plugin's handle is not satisfied by another plugin's same-shaped service.
  Library plugins take the handle as a parameter: `transactions(database.provides.db)`
  replaces `transactions<Db>()`.
- Wiring errors sit on the argument: `.use(x)` / `.features([...])` with a
  unit that cannot mount fails as "Property 'DOT: this unit needs services
  that nothing before it provides…' is missing", not "Expected 2 arguments,
  but got 1". `testPlugin(...).boot()` reports through its `this` type.
- `testApp(plugins)` / `bootTestApp(plugins)` type `app.services` from the
  tuple; the explicit `testApp<TServices>()` type argument is gone — drop it.
- `.usecases()` infers inline factories (`({ repos }) => …`); `.infra()`
  refuses two plugins that provide the same key; a list of more than 1024
  units is refused.
- New `feature.instance(name, rebind?)`: a second copy of a finished feature,
  named `<feature>#<instance>`, publishing under `<feature>#<instance>.<key>`;
  `rebind` points a need at another provider's handle of the same type, and
  children follow by handle identity. `#` is now reserved in a declared
  feature name. `instanceOf(name)` is exported for adapters.
- `@arki/schedule`, `@arki/queue`, `@arki/http` and `@arki/journal` register
  an instance's schedules, jobs, routes (`/<instance>/…`) and effects under
  instance-qualified names; a plain feature's names are unchanged.
- `WireNeeds` reads a need's wire key from the handle's `key` alone: a handle
  whose key holds `#` has one wire key (it used to split into two candidates).
- Removed: the `InferredProvides` type. `provide(token, value)` is only a
  record helper now.
- `@arki/db/dot` `db()` takes `url?: () => string | undefined`, read at boot
  (falls back to `DB_URL`).

## Conventions used in this guide (once entries exist)

Each version section will follow this template:

```markdown
## 1.0.0

### Breaking changes

- **`<symbol or contract>`** — what changed.
  - Before: `<old code>`
  - After: `<new code>`
  - Migration: `<step-by-step or codemod command>`

### Deprecations removed

- `<symbol>` — was deprecated in `0.x`; replacement: `<symbol>`.

### Non-breaking additions (informational)

- `<symbol>` — new in this release.
```

## See also

- [Release policy](./release-policy.md) — SemVer rules and deprecation
  cycle.
