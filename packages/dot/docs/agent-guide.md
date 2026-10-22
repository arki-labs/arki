# DOT for Agents

This guide is the agent's playbook for `@arki/dot`. Read [`llms.txt`](../llms.txt)
first: it lists the import paths and links here by task. When this guide, the
README or `llms.txt` disagree with the code, the code wins: `src/index.ts` for
the kernel API and `src/cli/index.ts` for the CLI. Every TypeScript block in
this guide and in the README is compiled by `bun run test:docs`.

## The model

1. A DOT app is a list of units: infra, features, entrypoints.
   `defineApp(name).infra(a).features([f]).entrypoints(b)` builds it. Infra
   boots first, entrypoints last. Declaration order is boot order. Teardown
   runs in reverse.
2. A unit declares `needs` (typed handles or `service<T>()` witnesses) and
   `provides` (one factory per key). The type of a service is inferred from its
   factory. It is written once.
3. Wrong wiring is a compile error at the `.infra()` call: a missing provider, a
   type mismatch, a key collision. The kernel checks again at runtime with
   coded errors (`ARKI_DOT_E012`, `E013`, `E020`).
4. A unit has five hooks: `configure` (sync, no I/O), `boot` (side effects,
   returns undefined, a refusal or an ownership plan), `start`, `stop`, `dispose`.
5. A feature is one chain: `defineFeature(name).needs(...).infra(...).domainServices(...).features(...).usecases(...).provides(...).entrypoints(...)`
   from `@arki/dot/feature`. `.domainServices()` and `.features()` are optional. The app mounts it with `.features([...])`.
6. `app.manifest` is the static graph (units, services, actions,
   dependencies, lifecycle, projections). `app.diagnostics` is the runtime
   snapshot (per-unit status, lifecycle, issues).
7. The CLI prints both as JSON. `dot explain --json` puts the manifest in
   `.data`. `dot doctor --json` puts the diagnostics snapshot in `.data`. There
   is no `.data.manifest` and no `.data.diagnostics`.
8. `dot explain` only calls `configure()`. It runs no `boot` hook.
   `dot doctor` calls `configure()`, then `boot()`, reads the diagnostics, then
   `dispose()`. It never calls `start()`.
9. The kernel has no MCP dependency. An MCP server can wrap the `--json`
   output. There is no `@arki/dot/mcp`.

## Task map

### Start a new app

`dot new` scaffolds an app. Templates: `stack` (default; TanStack Start, oRPC,
Postgres through `@arki/db`, `@arki/journal`) and `minimal` (`defineApp` + env).
Code: `src/cli/new.ts`; the `.data` types `DotNewResult` and `DotNewOperation`
in `src/cli/json.ts`, exported from `@arki/dot/cli`.

1. Preview. No files are written:

   ```sh
   npx dot new my-app --dry-run --json
   npx dot new my-app --template minimal --dry-run --json
   ```

2. Read `.data.operations[]`. Each entry has `path`, `action` (`create`,
   `overwrite` or `skip`), `contentHash` (sha256), `contentBytes` and `reason`.
3. Write the files:

   ```sh
   npx dot new my-app --json
   ```

   The real run returns the same `.data`. Pass `--target <dir>` to pick the
   folder and `--force` to overwrite files that exist. A non-empty target
   without `--force` is `dot.target_not_empty` (exit 3).

4. Read the generated `AGENTS.md` in the new app. It lists the verify commands
   for that app; `.data.nextSteps` lists the first commands to run.

Real output of `dot new demo --dry-run --json` (captured from the CLI;
`target` is the absolute path, shortened here; the stack template plans 38
operations, the first two are shown):

```json
{
  "ok": true,
  "command": ["new"],
  "data": {
    "app": { "name": "demo", "target": "/tmp/demo" },
    "operations": [
      {
        "path": ".dockerignore",
        "action": "create",
        "contentHash": "330dbfbfe5764a6b2b280e4a146d93c3a043a5988ea78b27808a947fa63e572e",
        "contentBytes": 80,
        "reason": "Keeps node_modules, build output and env files out of the Docker context"
      },
      {
        "path": ".env.example",
        "action": "create",
        "contentHash": "4df36adce2bf57b1422d78793a5ec7566b7aa6cef9eaefac0314971541835271",
        "contentBytes": 322,
        "reason": "Env vars the app reads, with local defaults"
      }
    ],
    "nextSteps": ["cd demo", "bun install", "cp .env.example .env", "docker compose up -d", "bun run dev"]
  },
  "error": null,
  "meta": { "schema": "arki.cli/1", "version": "0.6.1", "durationMs": 14, "dryRun": true }
}
```

An unknown template or app name exits 2 with `"ok": false` and
`.error.code == "cli.invalid_input"`; `.error.issues[]` names the flag. Read
the plan from code:

```ts
import { spawnSync } from 'node:child_process';

import type { Envelope } from '@arki/cli';
import type { DotNewResult } from '@arki/dot/cli';

const result = spawnSync('npx', ['dot', 'new', 'my-app', '--dry-run', '--json'], { encoding: 'utf8' });
const envelope: Envelope<DotNewResult> = JSON.parse(result.stdout);
export const overwrites = envelope.ok
  ? (envelope.data?.operations ?? []).filter(op => op.action !== 'create').map(op => op.path)
  : [];
```

### Inspect the app graph

1. Run `npx dot explain --json` (piped output is JSON even without
   `--json`). The CLI finds `./dot.config.ts`,
   `./src/app.ts` or `./app.ts`; pass `--app <path>` otherwise. The file's
   default export is the builder.
2. Read `.data`. It is the `DotAppManifest` (`src/manifest.ts`). Real output
   for a two-unit app (`reports` needs `database`'s `db`):

   ```json
   {
     "ok": true,
     "command": ["explain"],
     "data": {
       "manifestVersion": 2,
       "app": { "name": "jq-demo" },
       "plugins": [
         { "name": "database", "dependencies": [], "provides": ["db"] },
         { "name": "reports", "dependencies": ["db"], "provides": ["reports"] }
       ],
       "actions": [],
       "services": [{ "name": "reports", "plugin": "reports", "kind": "custom" }],
       "lifecycle": [
         { "plugin": "database", "hooks": ["boot"] },
         { "plugin": "reports", "hooks": ["configure", "boot", "start"] }
       ],
       "dependencies": [{ "from": "reports", "to": "database", "kind": "requires", "key": "db" }],
       "projections": []
     },
     "error": null,
     "meta": { "schema": "arki.cli/1", "version": "0.6.1", "durationMs": 3, "dryRun": false }
   }
   ```

3. The manifest is the source of truth for "what does this app do?". Do not
   guess it from `app.ts`.

The same data in code, without the CLI. `configure()` gives the manifest;
`boot()` gives the diagnostics:

```ts run
import { defineApp, infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure } from '@arki/failure';

const database = infra({ name: 'database', provides: { db: () => ({ query: async (sql: string) => [sql] }) } });
const reports = defineFeature('reports')
  .needs({ db: database.provides.db })
  .usecases({ daily: ({ db }) => () => db.query('daily') })
  .provides({ reports: ({ usecases }) => ({ daily: usecases.daily }) })
  .entrypoints();

// `dot explain --json` prints this manifest under `.data`. No boot hook runs.
const configured = defineApp('shop').infra(database).features([reports]).configure();
if (isFailure(configured)) throw new Error(configured.code);
const names = configured.manifest.plugins.map(p => p.name).join(',');
if (names !== 'database,reports') throw new Error(`unexpected units: ${names}`);
const edge = configured.manifest.dependencies.find(d => d.from === 'reports');
if (edge?.to !== 'database' || edge.key !== 'db') throw new Error('reports must depend on database through db');

// `dot doctor --json` prints this snapshot under `.data`: boot, read, dispose.
const app = await configured.boot();
if (isFailure(app)) throw new Error(app.code);
const notOk = app.diagnostics.plugins.filter(p => p.status !== 'ok').map(p => p.plugin);
await app.dispose();
if (notOk.length > 0) throw new Error(`units not ok: ${notOk.join(',')}`);
```

### Check runtime health

1. Run `npx dot doctor --json`. It exits `0` when the worst issue is a
   warning or less, and `3` with `.error.code == "dot.doctor_failed"` when an
   issue is an error or a managed phase failed. Read stdout either way.
2. On exit 0, `.data` is the diagnostics snapshot plus `.data.status`
   (`success` or `warning`). On exit 3, the same report is `.error.data`, with
   `.error.data.status == "failure"`.
3. `.data.issues` holds app-level issues; `.data.plugins[].issues`,
   `.data.actions[].issues`, `.data.services[].issues` and
   `.data.lifecycle[].issues` hold the rest.
4. Each issue has `code`, `severity`, `unit`, `message`, `remediation` and
   `docsUrl`. Apply the `remediation`, then run doctor again.

```ts
import { spawnSync } from 'node:child_process';

import type { Envelope } from '@arki/cli';
import type { DoctorReport } from '@arki/dot/cli';

// doctor exits 3 on dot.doctor_failed; stdout still holds the JSON.
const result = spawnSync('npx', ['dot', 'doctor', '--json'], { encoding: 'utf8' });
const envelope: Envelope<DoctorReport> = JSON.parse(result.stdout);
const isReport = (value: unknown): value is DoctorReport =>
  typeof value === 'object' && value !== null && 'units' in value;
const report = envelope.ok ? envelope.data : isReport(envelope.error.data) ? envelope.error.data : null;
const issues = report === null ? [] : [...report.issues, ...report.plugins.flatMap(p => p.issues)];
export const fixes = issues
  .filter(issue => issue.severity === 'error')
  .map(issue => `${issue.code} (${issue.plugin ?? 'app'}): ${issue.remediation}`);
export const failedUnits = (report?.plugins ?? []).filter(p => p.status === 'failed').map(p => p.plugin);
```

Pass `--observability` to also check that an OpenTelemetry SDK is registered
(`dot.observability_no_sdk` warning when not). Pass `--graph` to print the observed wiring
as Mermaid.

### Add a unit

1. Write the unit with `infra({ name, needs, provides, ...hooks })` from
   `@arki/dot`. Name needs by handle (`database.provides.db`) when you can
   import the provider.
2. Chain `.infra(myInfra)` after its providers in `app.ts`.
3. `npx dot explain --json | jq '.data.plugins[].name'`: the unit is listed.
4. `npx dot doctor --json | jq '.data.lifecycle'`: every hook ran.

### Add a feature

1. Write the chain in `features/<name>/feature.ts` with `defineFeature` from
   `@arki/dot/feature`. Order: `needs`, `infra`, `domainServices`, `features`
   (children), `usecases`, `provides`, `entrypoints`. The section "Features as a chain" in
   [Dependency injection](di.md) has the full shape.
2. One file per usecase in `usecases/`. It imports `type Deps` from
   `../feature` and asks for `Pick<Deps, ...>`. (A factory written inline in
   `feature.ts` needs no annotation: `({ store }) => …` gets the deps type.)
3. When two or more usecases share logic that needs a port, or a child feature
   needs it, write one file in `domain-services/` and register it with
   `.domainServices({ name: factory })`. The factory asks for
   `Pick<DomainDeps, ...>`, where `DomainDeps` is what a domain service may
   ask for. A child names it with `domainService(fn)`.
4. `provides` factories get `{ usecases }` and nothing else. Entrypoints get
   usecases, the request keys and needs marked `entrypointOnly(...)`.
5. Mount it with `.features([myFeature])`.
6. `npx dot explain --json | jq '.data.dependencies'`: the feature's edges
   show, with the capability `key`.

### Add an action

1. Declare `actions: [...]` on the unit, or call `ctx.registerAction({ id,
binding, direction, address })` in `configure`. `rpc()` from
   `@arki/dot/orpc` adds one action per procedure.
2. `npx dot explain --json | jq '.data.actions'`: the action is listed with its
   unit.
3. `npx dot doctor --json | jq '.data.actions'`: its `status` is `"ok"`.

### Wrap a handler (auth, a transaction)

1. Write a step (`(ctx) => object | Failure`) or an around
   (`<T>(ctx, next: () => Promise<T>) => Promise<T>`) as a plain function.
   Auth checks already exist: `authed`, `verified`, `role(name)` from `@arki/auth`.
2. Attach it with the transport's `step()` / `around()` (`@arki/dot/orpc`,
   `@arki/http`, `@arki/queue`) or list it in `with: [...]` (schedule, CLI).
3. Declare the step's failures on the procedure or route. Missing ones are a
   compile error.
4. App-wide logging and error reports are observers, not steps: `logHandlers()`,
   `reportErrors({ report })` in `defineApp(name, { observers })`.

Full model: [Steps and arounds](middleware.md).

### Add an env var

1. Add the key to the env schema of the env unit (`@arki/dot/env`).
2. `npx dot explain --json | jq '.data.services[] | select(.kind == "env")'`:
   the env service is still registered.
3. `npx dot doctor --json | jq '.data.issues'`: empty unless the var is
   missing at runtime.

### Debug a boot failure

1. `npx dot doctor -o json | jq '.error.data.plugins[] | select(.status == "failed")'`.
2. `npx dot doctor --json | jq '.data.plugins[] | select(.status != "ok")'`
   names the unit.
3. A hook may return its canonical refusal; an unknown throw becomes
   `UnexpectedDefect` retaining its original private cause, while diagnostics
   record `ARKI_DOT_E003` with the boot phase and unit.
   The kernel rolls back owned resources before returning.
4. Apply the first `remediation`. Run doctor again. Repeat.

### Boot-check an app

`dot dev --once --json` is the agent's boot check. It resolves the database,
validates env, applies the committed migrations and boots the app, then exits.
It refuses a non-local `DB_URL` unless you pass `--allow-remote-db`.

- `ok: true`: `.data.items` lists the events in order: `app`, `db`,
  `migrations` (the names the boot applied), `preflight`.
- A managed preflight failure: `.error.code` is `dot.preflight_failed`;
  `.error.data` contains `app`, `migrations`, `report` and `failure`. Read
  `.error.data.failure.code` and `.error.data.report` (either can be null).
  Process failures use `dot.dev_preflight_failed`; database and runner failures use other `dot.dev_*` codes.

### Work in a generated app

Every app from `dot new` has an `AGENTS.md` at its root. It names the verify
commands, the files agents may edit, and where DOT files live. Read it first.
With no `AGENTS.md`, read the manifest, ask before large edits, and run the
`Verify` commands after each change.

## Rules that bite

- `configure` is sync. A `configure` that returns a Promise fails with
  `ARKI_DOT_E001`.
- Hooks return `undefined` or a concrete failure; `boot` can also return an
  ownership plan. Service values go in `provides`. Detached `void` or
  `Promise<void>` callbacks must return explicit `undefined` or be written inline.
  See [Upgrade typed phases](upgrade-phases.md).
- Providers come before consumers in `.infra()`, `.features([...])` and `.entrypoints()`. The
  wrong order is a compile error, and `ARKI_DOT_E020` for erased code.
- A step sees only what is written above it. `.domainServices()` goes once,
  right after `.infra()` (`ARKI_DOT_E035` otherwise). `provides` sees only
  `{ usecases }`. Entrypoints see usecases, request keys and `entrypointOnly`
  needs. To publish data behind a repository, write a usecase and provide it;
  the consumer gets `Value | Failure<'failure.unexpected_defect'>`.
- A domain service factory cannot return a `Failure`, and it reads env when it
  is used, not at boot. Feature infra never imports a `feature.ts`.
- Two providers of one wire key collide. Use `rename(unit, { key: 'newKey' }, 'new-name')`
  for a second instance.
- `$`-prefixed keys are reserved for the kernel (`$app`, `$unit`,
  `$config`, `$signal`).
- An app has at most one logging unit. `log()` from `@arki/dot/log` goes first.
- Do not cast an app to reach its manifest. Call `builder.configure()`, check
  `isFailure`, then read `configured.manifest`; a booted app has `app.manifest`.
- `.data` is the payload. `jq '.data.manifest'` and `jq '.data.diagnostics'`
  return `null`.
- `dot doctor` never calls `start()`. Workers and servers in `start` are not
  checked by doctor; test them in your app's tests.
- `@orpc/server` is an optional peer. Only `@arki/dot/orpc` loads it.
- A step must not return `{}` on success: TypeScript folds `{} | Failure` into
  `{}`, so the failure drops out of the type and nobody has to declare it.
  Return a non-empty object (`{ isAdmin: true }`).
- Handler events come only from handlers Dot mounts (oRPC through `bind`,
  HTTP routes, jobs, schedules). A procedure built from plain `os` emits none.
- Adapters (`@arki/dot/env`, `@arki/db/dot`, `@arki/kv/dot`,
  `@arki/journal/dot`) live in their own packages. `@arki/dot` never imports
  them.

## Ownership

Use `resource`, `cleanup` and `child` from `@arki/async` for owned construction; see [Ownership](ownership.md). Check returned failures from configure/boot/start/stop/dispose and lazy get/dispose. Failed services never publish. Deadlines request cancellation and join admitted work before finalization.

## Errors

`dot` exits `0` on success, `1` on a bug (`cli.bug`), `2` on a usage error
(`cli.*`) and `3` on a returned failure (including `dot.*` and canonical failures). Every failure envelope has
`.error.code`, `.error.message`, `.error.remediation` and `.error.docsUrl`;
`jq '.error.remediation'` is the fix. Kernel errors (`ARKI_DOT_E*`) appear as
issue codes inside diagnostics. A returned configure refusal propagates its
canonical code unchanged; serialized `UnexpectedDefect` data is null.
Compatibility callbacks that throw can produce `dot.app_lifecycle_failed`
with `.error.data.underlyingCode`.

| Code                                                                        | Meaning                                                                                                                                                 | What to do                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `dot.action_not_exposed`                                                    | The adapter is not exposed by the action.                                                                                                               | Use a declared binding.                                                                 |
| `dot.action_principal_required`                                             | No authenticated principal attestation.                                                                                                                 | Authenticate credentials and expiry at the adapter.                                     |
| `dot.action_approval_required`                                              | No invocation approval attestation.                                                                                                                     | Verify caller, action and input approval at the adapter.                                |
| `cli.unknown_command` (exit 2)                                              | Unknown command. `.error.data.suggestions` holds close names.                                                                                           | Use `explain`, `doctor` or `new`; `dot --help` lists them.                              |
| `cli.invalid_input` (exit 2)                                                | Bad flags, for example an unknown `--template`, an invalid app name, or `--as` with `--graph`.                                                          | Fix the flags named in `.error.issues[]`; `dot <command> --help` lists them.            |
| `dot.app_not_found` (exit 3)                                                | No app file found and no `--app`.                                                                                                                       | Pass `--app <path>`, or create `dot.config.ts`.                                         |
| `dot.app_invalid_export` (exit 3)                                           | The app file has no usable app export: the `default`/`app` export is not a DOT app, there is none, or several are exported and none is `default`/`app`. | `export default defineApp(...)` or `export const app = defineApp(...)`.                 |
| `dot.app_import_failed` (exit 3)                                            | Importing the app file, or calling its factory export, threw.                                                                                           | Apply `.error.data.causeRemediation` when set; otherwise run `bun <path>` to reproduce. |
| `dot.app_lifecycle_failed` (exit 3)                                         | A compatibility callback threw during configure. `.error.data.underlyingCode` is the kernel code when available.                                        | Fix that code; `ARKI_DOT_E020` means a provider is mounted after its consumer.          |
| `dot.doctor_failed` (exit 3)                                                | `doctor` found an error issue, or a managed phase failed. `.error.data` is the report.                                                                  | Apply each issue's `remediation` in `.error.data.plugins[].issues`.                     |
| `dot.preflight_failed` (exit 3)                                             | Managed preflight failed. `.error.data` contains `app`, `migrations`, `report` and `failure`.                                                           | Read `.error.data.failure.code` and `.error.data.report`; fix the lifecycle failure.    |
| `dot.observability_no_sdk`                                                  | `doctor --observability`: no OpenTelemetry SDK registered. A warning issue in `.data.issues`, not a failure.                                            | Register an SDK once at app entry; see `docs/observability.md`.                         |
| `dot.projection_*` (exit 3)                                                 | `explain --as`: `projection_not_found`, `projection_import_failed`, `projection_execution_failed`, `projection_conflict`.                               | Check the projection module the adapter registers; `--module` tries a replacement.      |
| `dot.target_not_empty`, `dot.template_missing`, `dot.write_failed` (exit 3) | `dot new`: the target has files, the package ships no templates, or a write failed.                                                                     | Pick an empty `--target` or pass `--force`; reinstall `@arki/dot`; check permissions.   |
| `dot.lazy_closed`                                                           | The lazy owner closed admission.                                                                                                                        | Use a live handle.                                                                      |
| `dot.runtime_replaced`                                                      | HMR replaced this module.                                                                                                                               | Use the current runtime.                                                                |
| `dot.runtime_release_failed`                                                | Prior resources failed to release.                                                                                                                      | Resolve disposal before restarting.                                                     |
| `ARKI_DOT_E001`                                                             | `configure` returned a Promise.                                                                                                                         | Move async work to `boot`.                                                              |
| `ARKI_DOT_E002`                                                             | `configure` threw.                                                                                                                                      | Fix the unit config.                                                                    |
| `ARKI_DOT_E003`                                                             | `boot` threw. Booted units were rolled back.                                                                                                            | Read the issue's `unit` and `remediation`.                                              |
| `ARKI_DOT_E004`                                                             | `start` threw.                                                                                                                                          | Fix the unit's `start`.                                                                 |
| `ARKI_DOT_E005` / `E006`                                                    | One or more `stop` / `dispose` hooks threw.                                                                                                             | Read the aggregated causes.                                                             |
| `ARKI_DOT_E007` / `E008`                                                    | The app was reused after `dispose` or after a failure.                                                                                                  | Build a new app.                                                                        |
| `ARKI_DOT_E011`                                                             | A unit was registered twice.                                                                                                                            | Remove the duplicate mount.                                                          |
| `ARKI_DOT_E012`                                                             | A need has no provider (erased or JS graphs).                                                                                                           | Mount the provider earlier.                                                             |
| `ARKI_DOT_E013`                                                             | A wire key is provided twice.                                                                                                                           | `rename` one provider.                                                                  |
| `ARKI_DOT_E014`                                                             | A key uses the reserved `$` prefix.                                                                                                                     | Rename the key.                                                                         |
| `ARKI_DOT_E015`                                                             | A hook ran past `hookTimeoutMs`.                                                                                                                        | Pass `$signal` to the hook's I/O; raise the budget only with a reason.                  |
| `ARKI_DOT_E016` / `E017`                                                    | Duplicate action id, or action meta that is not JSON.                                                                                                   | Rename the action; keep meta plain JSON.                                                |
| `ARKI_DOT_E018`                                                             | More than one logging unit.                                                                                                                             | Keep one `log()`.                                                                       |
| `ARKI_DOT_E019`                                                             | Feature needs form a ring.                                                                                                                              | Extract the shared piece into a third unit.                                             |
| `ARKI_DOT_E020`                                                             | A provider is mounted after its consumer.                                                                                                               | Move it earlier; the message names both positions.                                      |
| `ARKI_DOT_E026`                                                             | A handle is missing from the services bag.                                                                                                              | Mount the provider; check the gateway's needs.                                          |
| `ARKI_DOT_E027`                                                             | A feature key collides with another slot or a reserved name.                                                                                            | Rename the alias or key.                                                                |
| `ARKI_DOT_E031`                                                             | A procedure's contract `meta` is not plain JSON.                                                                                                        | Keep contract meta JSON-safe.                                                           |
| `ARKI_DOT_E034`                                                             | A feature needs `domainService(fn)` its parent does not declare above `.features()`, or it is top-level.                                                | Declare `fn` in the parent's `.domainServices()`; need it from a child only.            |
| `ARKI_DOT_E035`                                                             | `.domainServices()` ran twice, or after `.features()`, `.usecases()` or `.provides()`.                                                                  | Call it once, right after `.infra()`.                                                   |

Full lifecycle table: [Lifecycle](lifecycle.md). Diagnostics shapes:
[Diagnostics](diagnostics.md).

## Verify

Run these after a change. A change is done when all pass.

In `packages/dot` (changes to the library or its docs):

```sh
bun run build          # the doc examples compile against dist/
bun run test:docs      # every ts block in README.md and this guide
bun run test           # vitest, includes src/cli/json-paths.test.ts
bun run typecheck
bun run lint
```

In an app (changes to an app built on DOT):

```sh
npx tsc --noEmit
npx dot explain --json | jq -e '.ok and .meta.schema == "arki.cli/1"'
npx dot explain --json | jq '.data.plugins[].name'
npx dot doctor --json | jq -e '.ok'
npx dot doctor --json | jq '.data.plugins[] | select(.status != "ok")'
```

The last command prints nothing on a healthy app. `src/cli/json-paths.test.ts`
checks that every `jq` path in this guide exists in the real CLI output.

## See also

- [Diagnostics](diagnostics.md): the manifest and diagnostics contracts.
- [Lifecycle](lifecycle.md): every lifecycle error code.
- [Unit authoring](unit-authoring.md): write a unit.
- [Adapter authoring](adapter-authoring.md): expose a package as a `./dot` unit.
- [Observability](observability.md): OpenTelemetry, observers, `app.timeline()`.
- [Steps and arounds](middleware.md): wrap a handler once for every transport.
- [Quickstart](quickstart.md): build an app, break it, read the error.
- [Dependency injection](di.md): needs, provides, tokens, `rename`, features.
- [The `dot` command](cli.md): every command and its side effects.
- [Testing units](testing.md) and [Logging, shutdown and timeouts](operations.md).
- Recipes: [Deploy an app](recipes/deploy.md), [Upgrade Dot](recipes/upgrade.md).

## Author action boundaries

Use [actions](actions.md) for `action`, `bindAction`, native validation ownership and
canonical failures. Use [upgrade-actions](upgrade-actions.md) when migrating callers.
