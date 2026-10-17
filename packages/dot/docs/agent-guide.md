# DOT for Agents

This guide is the agent's playbook for `@arki/dot`. Read [`llms.txt`](../llms.txt)
first: it lists the import paths and links here by task. When this guide, the
README or `llms.txt` disagree with the code, the code wins: `src/index.ts` for
the kernel API and `src/cli/index.ts` for the CLI. Every TypeScript block in
this guide and in the README is compiled by `bun run test:docs`.

## The model

1. A DOT app is a list of plugins. `defineApp(name).use(a).use(b)` builds it.
   Declaration order is boot order. Teardown runs in reverse.
2. A plugin declares `needs` (typed handles or `service<T>()` witnesses) and
   `provides` (one factory per key). The type of a service is inferred from its
   factory. It is written once.
3. Wrong wiring is a compile error at the `.use()` call: a missing provider, a
   type mismatch, a key collision. The kernel checks again at runtime with
   coded errors (`ARKI_DOT_E012`, `E013`, `E020`).
4. A plugin has five hooks: `configure` (sync, no I/O), `boot` (side effects,
   returns nothing), `start`, `stop`, `dispose`.
5. A feature is one chain: `defineFeature(name).needs(...).infra(...).usecases(...).provides(...).entrypoints(...)`
   from `@arki/dot/feature`. The app mounts it with `.features([...])`.
6. `app.manifest` is the static graph (plugins, services, actions,
   dependencies, lifecycle, projections). `app.diagnostics` is the runtime
   snapshot (per-plugin status, lifecycle, issues).
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
   for a two-plugin app (`reports` needs `database`'s `db`):

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
import { defineApp, plugin } from '@arki/dot';

const database = plugin({ name: 'database', provides: { db: () => ({ query: async (sql: string) => [sql] }) } });
const reports = plugin({
  name: 'reports',
  needs: { db: database.provides.db },
  provides: { reports: ({ db }) => ({ daily: () => db.query('daily') }) },
});

// `dot explain --json` prints this manifest under `.data`. No boot hook runs.
const configured = defineApp('shop').use(database).use(reports).configure();
const names = configured.manifest.plugins.map(p => p.name).join(',');
if (names !== 'database,reports') throw new Error(`unexpected plugins: ${names}`);
const edge = configured.manifest.dependencies.find(d => d.from === 'reports');
if (edge?.to !== 'database' || edge.key !== 'db') throw new Error('reports must depend on database through db');

// `dot doctor --json` prints this snapshot under `.data`: boot, read, dispose.
const app = await configured.boot();
const notOk = app.diagnostics.plugins.filter(p => p.status !== 'ok').map(p => p.plugin);
await app.dispose();
if (notOk.length > 0) throw new Error(`plugins not ok: ${notOk.join(',')}`);
```

### Check runtime health

1. Run `npx dot doctor --json`. It exits `0` when the worst issue is a
   warning or less, and `3` with `.error.code == "dot.doctor_failed"` when an
   issue is an error or boot threw. Read stdout either way.
2. On exit 0, `.data` is the diagnostics snapshot plus `.data.status`
   (`success` or `warning`). On exit 3, the same report is `.error.data`, with
   `.error.data.status == "failure"`.
3. `.data.issues` holds app-level issues; `.data.plugins[].issues`,
   `.data.actions[].issues`, `.data.services[].issues` and
   `.data.lifecycle[].issues` hold the rest.
4. Each issue has `code`, `severity`, `plugin`, `message`, `remediation` and
   `docsUrl`. Apply the `remediation`, then run doctor again.

```ts
import { spawnSync } from 'node:child_process';

import type { Envelope } from '@arki/cli';
import type { DoctorReport } from '@arki/dot/cli';

// doctor exits 3 on dot.doctor_failed; stdout still holds the JSON.
const result = spawnSync('npx', ['dot', 'doctor', '--json'], { encoding: 'utf8' });
const envelope: Envelope<DoctorReport> = JSON.parse(result.stdout);
const isReport = (value: unknown): value is DoctorReport =>
  typeof value === 'object' && value !== null && 'plugins' in value;
const report = envelope.ok ? envelope.data : isReport(envelope.error.data) ? envelope.error.data : null;
const issues = report === null ? [] : [...report.issues, ...report.plugins.flatMap(p => p.issues)];
export const fixes = issues
  .filter(issue => issue.severity === 'error')
  .map(issue => `${issue.code} (${issue.plugin ?? 'app'}): ${issue.remediation}`);
export const failedPlugins = (report?.plugins ?? []).filter(p => p.status === 'failed').map(p => p.plugin);
```

Pass `--observability` to also check that an OpenTelemetry SDK is registered
(`dot.observability_no_sdk` warning when not). Pass `--graph` to print the observed wiring
as Mermaid.

### Add a plugin

1. Write the plugin with `plugin({ name, needs, provides, ...hooks })` from
   `@arki/dot`. Name needs by handle (`database.provides.db`) when you can
   import the provider.
2. Chain `.use(myPlugin)` after its providers in `app.ts`.
3. `npx dot explain --json | jq '.data.plugins[].name'`: the plugin is listed.
4. `npx dot doctor --json | jq '.data.lifecycle'`: every hook ran.

### Add a feature

1. Write the chain in `features/<name>/feature.ts` with `defineFeature` from
   `@arki/dot/feature`. Order: `needs`, `infra`, `usecases`, `provides`,
   `entrypoints`. The README section "Features as a chain" has the full shape.
2. One file per usecase in `usecases/`. It imports `type Deps` from
   `../feature` and asks for `Pick<Deps, ...>`. (A factory written inline in
   `feature.ts` needs no annotation: `({ store }) => …` gets the deps type.)
3. Mount it with `.features([myFeature])`.
4. `npx dot explain --json | jq '.data.dependencies'`: the feature's edges
   show, with the capability `key`.

### Add an action

1. Declare `actions: [...]` on the plugin, or call `ctx.registerAction({ id,
binding, direction, address })` in `configure`. `rpc()` from
   `@arki/dot/orpc` adds one action per procedure.
2. `npx dot explain --json | jq '.data.actions'`: the action is listed with its
   plugin.
3. `npx dot doctor --json | jq '.data.actions'`: its `status` is `"ok"`.

### Add an env var

1. Add the key to the env schema of the env plugin (`@arki/env/dot`).
2. `npx dot explain --json | jq '.data.services[] | select(.kind == "env")'`:
   the env service is still registered.
3. `npx dot doctor --json | jq '.data.issues'`: empty unless the var is
   missing at runtime.

### Debug a boot failure

1. `npx dot doctor -o json | jq '.error.data.plugins[] | select(.status == "failed")'`.
2. `npx dot doctor --json | jq '.data.plugins[] | select(.status != "ok")'`
   names the plugin.
3. `ARKI_DOT_E003` means that plugin's `boot` threw. The kernel already
   rolled back the plugins that booted before it.
4. Apply the first `remediation`. Run doctor again. Repeat.

### Boot-check an app

`dot dev --once --json` is the agent's boot check. It resolves the database,
validates env, applies the committed migrations and boots the app, then exits.
It refuses a non-local `DB_URL` unless you pass `--allow-remote-db`.

- `ok: true`: `.data.items` lists the events in order: `app`, `db`,
  `migrations` (the names the boot applied), `preflight`.
- A failure: `.error.code` is a `dot.dev_*` code or `dot.doctor_failed`. The
  doctor diagnostics are in `.error.data`.

### Work in a generated app

Every app from `dot new` has an `AGENTS.md` at its root. It names the verify
commands, the files agents may edit, and where DOT files live. Read it first.
With no `AGENTS.md`, read the manifest, ask before large edits, and run the
`Verify` commands after each change.

## Rules that bite

- `configure` is sync. A `configure` that returns a Promise fails with
  `ARKI_DOT_E001`.
- `boot` returns nothing. Values go in `provides`. A value-returning `boot`
  does not compile.
- Providers come before consumers in `.use()` and `.features([...])`. The
  wrong order is a compile error, and `ARKI_DOT_E020` for erased code.
- Two providers of one wire key collide. Use `rename(plugin, { key: 'newKey' }, 'new-name')`
  for a second instance.
- `$`-prefixed keys are reserved for the kernel (`$app`, `$plugin`,
  `$config`, `$signal`).
- An app has at most one logging plugin. `log()` from `@arki/dot/log` goes first.
- Do not cast an app to reach its manifest. Call `.configure().manifest` on
  the builder, or read `app.manifest` on a booted app.
- `.data` is the payload. `jq '.data.manifest'` and `jq '.data.diagnostics'`
  return `null`.
- `dot doctor` never calls `start()`. Workers and servers in `start` are not
  checked by doctor; test them in your app's tests.
- `@orpc/server` is an optional peer. Only `@arki/dot/orpc` loads it.
- Adapters (`@arki/env/dot`, `@arki/db/dot`, `@arki/kv/dot`,
  `@arki/journal/dot`) live in their own packages. `@arki/dot` never imports
  them.

## Errors

`dot` exits `0` on success, `1` on a bug (`cli.bug`), `2` on a usage error
(`cli.*`) and `3` on a returned failure (`dot.*`). Every failure envelope has
`.error.code`, `.error.message`, `.error.remediation` and `.error.docsUrl`;
`jq '.error.remediation'` is the fix. Kernel errors (`ARKI_DOT_E*`) appear as
issue codes inside the diagnostics.

| Code                                                                        | Meaning                                                                                                                                                 | What to do                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cli.unknown_command` (exit 2)                                              | Unknown command. `.error.data.suggestions` holds close names.                                                                                           | Use `explain`, `doctor` or `new`; `dot --help` lists them.                              |
| `cli.invalid_input` (exit 2)                                                | Bad flags, for example an unknown `--template`, an invalid app name, or `--as` with `--graph`.                                                          | Fix the flags named in `.error.issues[]`; `dot <command> --help` lists them.            |
| `dot.app_not_found` (exit 3)                                                | No app file found and no `--app`.                                                                                                                       | Pass `--app <path>`, or create `dot.config.ts`.                                         |
| `dot.app_invalid_export` (exit 3)                                           | The app file has no usable app export: the `default`/`app` export is not a DOT app, there is none, or several are exported and none is `default`/`app`. | `export default defineApp(...)` or `export const app = defineApp(...)`.                 |
| `dot.app_import_failed` (exit 3)                                            | Importing the app file, or calling its factory export, threw.                                                                                           | Apply `.error.data.causeRemediation` when set; otherwise run `bun <path>` to reproduce. |
| `dot.app_lifecycle_failed` (exit 3)                                         | `configure` threw while the CLI prepared the app.                                                                                                       | Run `dot doctor --json` for per-plugin issues.                                          |
| `dot.doctor_failed` (exit 3)                                                | `doctor` found an error issue, or boot threw. `.error.data` is the report.                                                                              | Apply each issue's `remediation` in `.error.data.plugins[].issues`.                     |
| `dot.observability_no_sdk`                                                  | `doctor --observability`: no OpenTelemetry SDK registered. A warning issue in `.data.issues`, not a failure.                                            | Register an SDK once at app entry; see `docs/observability.md`.                         |
| `dot.projection_*` (exit 3)                                                 | `explain --as`: `projection_not_found`, `projection_import_failed`, `projection_execution_failed`, `projection_conflict`.                               | Check the projection module the adapter registers; `--module` tries a replacement.      |
| `dot.target_not_empty`, `dot.template_missing`, `dot.write_failed` (exit 3) | `dot new`: the target has files, the package ships no templates, or a write failed.                                                                     | Pick an empty `--target` or pass `--force`; reinstall `@arki/dot`; check permissions.   |
| `ARKI_DOT_E001`                                                             | `configure` returned a Promise.                                                                                                                         | Move async work to `boot`.                                                              |
| `ARKI_DOT_E002`                                                             | `configure` threw.                                                                                                                                      | Fix the plugin config.                                                                  |
| `ARKI_DOT_E003`                                                             | `boot` threw. Booted plugins were rolled back.                                                                                                          | Read the issue's `plugin` and `remediation`.                                            |
| `ARKI_DOT_E004`                                                             | `start` threw.                                                                                                                                          | Fix the plugin's `start`.                                                               |
| `ARKI_DOT_E005` / `E006`                                                    | One or more `stop` / `dispose` hooks threw.                                                                                                             | Read the aggregated causes.                                                             |
| `ARKI_DOT_E007` / `E008`                                                    | The app was reused after `dispose` or after a failure.                                                                                                  | Build a new app.                                                                        |
| `ARKI_DOT_E011`                                                             | A plugin was registered twice.                                                                                                                          | Remove the duplicate `.use()`.                                                          |
| `ARKI_DOT_E012`                                                             | A need has no provider (erased or JS graphs).                                                                                                           | Mount the provider earlier.                                                             |
| `ARKI_DOT_E013`                                                             | A wire key is provided twice.                                                                                                                           | `rename` one provider.                                                                  |
| `ARKI_DOT_E014`                                                             | A key uses the reserved `$` prefix.                                                                                                                     | Rename the key.                                                                         |
| `ARKI_DOT_E015`                                                             | A hook ran past `hookTimeoutMs`.                                                                                                                        | Pass `$signal` to the hook's I/O; raise the budget only with a reason.                  |
| `ARKI_DOT_E016` / `E017`                                                    | Duplicate action id, or action meta that is not JSON.                                                                                                   | Rename the action; keep meta plain JSON.                                                |
| `ARKI_DOT_E018`                                                             | More than one logging plugin.                                                                                                                           | Keep one `log()`.                                                                       |
| `ARKI_DOT_E019`                                                             | Feature needs form a ring.                                                                                                                              | Extract the shared piece into a third unit.                                             |
| `ARKI_DOT_E020`                                                             | A provider is mounted after its consumer.                                                                                                               | Move it earlier; the message names both positions.                                      |
| `ARKI_DOT_E026`                                                             | A handle is missing from the services bag.                                                                                                              | Mount the provider; check the gateway's needs.                                          |
| `ARKI_DOT_E027`                                                             | A feature key collides with another slot or a reserved name.                                                                                            | Rename the alias or key.                                                                |
| `ARKI_DOT_E031`                                                             | A procedure's contract `meta` is not plain JSON.                                                                                                        | Keep contract meta JSON-safe.                                                           |

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
- [Plugin authoring](plugin-authoring.md): write a plugin.
- [Adapter authoring](adapter-authoring.md): expose a package as a `./dot` plugin.
- [Observability](observability.md): OpenTelemetry, observers, `app.timeline()`.
- [Quickstart](quickstart.md): boot a first app.
