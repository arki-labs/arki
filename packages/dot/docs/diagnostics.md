# Diagnostics

DOT exposes two parallel observability surfaces:

- **`app.manifest`** — the static graph (what the app **is**).
- **`app.diagnostics`** — the runtime snapshot (how the app **is doing**).

Both are first-class data contracts, designed to be consumed by humans **and**
agents.

## `DotAppManifest`

The manifest is the declarative description of an app. It is finalised once
`configure()` completes and never changes afterwards.

```ts
import type { DotAppManifest as ExportedManifest } from '@arki/dot';

type DotAppManifest = {
  manifestVersion: 2;
  app: { name: string; version?: string };
  plugins: UnitManifest[];
  actions: ActionManifest[];
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
  projections: ProjectionManifest[];
};

// Shapes are written out to read. This line stops compiling if one drifts from the exported type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const manifestMatches: Same<DotAppManifest, ExportedManifest> = true;

// The sub-shapes are in the next block.
type UnitManifest = ExportedManifest['plugins'][number];
type ActionManifest = ExportedManifest['actions'][number];
type ServiceManifest = ExportedManifest['services'][number];
type LifecycleManifest = ExportedManifest['lifecycle'][number];
type DependencyEdge = ExportedManifest['dependencies'][number];
type ProjectionManifest = ExportedManifest['projections'][number];
```

**Six-array contract.** The six top-level arrays (`plugins`, `actions`,
`services`, `lifecycle`, `dependencies`, `projections`) are **always
present**, even when empty. Consumers must never see an omitted array.

### Sub-shapes

```ts
import type { DotAppManifest, DotLifecycleHook, JsonObject } from '@arki/dot';

type UnitManifest = {
  name: string;
  role?: 'infra' | 'feature' | 'domain-service' | 'entrypoint'; // the role the unit was built with
  dependencies: readonly string[];
  provides: readonly string[];
};

type ActionManifest = {
  id: string;
  plugin: string;
  binding: string;
  direction: 'in' | 'out';
  address?: string;
  summary?: string;
  meta?: Readonly<JsonObject>;
  metaSchema?: string;
};

type ServiceManifest = {
  name: string;
  plugin: string;
  kind: 'env' | 'db' | 'kv' | 'queue' | 'auth' | 'email' | 'logger' | 'event-store' | 'message-bus' | 'custom';
};

type LifecycleManifest = {
  plugin: string;
  hooks: readonly DotLifecycleHook[];
};

type DependencyEdge = {
  from: string;
  to: string;
  kind: 'requires' | 'provides' | 'uses';
  key?: string; // the capability, on edges derived at configure() from static provides
};

type ProjectionManifest = {
  format: string;
  binding: string;
  module: string;
  plugin: string;
};

// Each shape must equal the entry type of the exported manifest.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const unitMatches: Same<UnitManifest, DotAppManifest['plugins'][number]> = true;
export const actionMatches: Same<ActionManifest, DotAppManifest['actions'][number]> = true;
export const serviceMatches: Same<ServiceManifest, DotAppManifest['services'][number]> = true;
export const lifecycleMatches: Same<LifecycleManifest, DotAppManifest['lifecycle'][number]> = true;
export const edgeMatches: Same<DependencyEdge, DotAppManifest['dependencies'][number]> = true;
export const projectionMatches: Same<ProjectionManifest, DotAppManifest['projections'][number]> = true;
```

## `DotDiagnosticsSnapshot`

A diagnostics snapshot is a point-in-time record. Reading
`app.diagnostics` re-computes it from the kernel's live state.

```ts
import type { DotLifecycleState, DotDiagnosticsSnapshot as ExportedSnapshot } from '@arki/dot';

type DotDiagnosticsSnapshot = {
  snapshotVersion: 2;
  generatedAt: string; // ISO-8601
  app: { name: string; state: DotLifecycleState };
  plugins: ExportedSnapshot['plugins'];
  actions: ExportedSnapshot['actions'];
  services: ExportedSnapshot['services'];
  lifecycle: ExportedSnapshot['lifecycle'];
  issues: ExportedSnapshot['issues'];
};

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const snapshotMatches: Same<DotDiagnosticsSnapshot, ExportedSnapshot> = true;
```

**Five-array contract.** Same rule as the manifest — `plugins`, `actions`,
`services`, `lifecycle`, `issues` are always present.

### `DiagnosticIssue`

The single actionable record:

```ts
import type { DiagnosticIssue as ExportedIssue } from '@arki/dot';

type DiagnosticIssue = {
  code: string; // stable machine-readable code, e.g. ARKI_DOT_E003
  severity: 'info' | 'warning' | 'error';
  plugin?: string; // owning unit, when applicable
  message: string; // human-readable summary
  remediation: string; // what the developer (or agent) should do
  docsUrl: string; // link to the relevant doc
  metadata?: Record<string, unknown>;
};

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const issueMatches: Same<DiagnosticIssue, ExportedIssue> = true;
```

Every issue is required to carry `code`, `message`, `remediation`, and
`docsUrl`. Diagnostics are never "something went wrong" — they are always
actionable.

## Programmatic access

```ts run expect
import { defineApp, infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure } from '@arki/failure';

const database = infra({ name: 'database', provides: { db: () => ({ ready: true }) } });
const billing = defineFeature('billing')
  .needs({ db: database.provides.db })
  .usecases({
    ready:
      ({ db }) =>
      () =>
        db.ready,
  })
  .provides({ billing: ({ usecases }) => ({ ready: usecases.ready }) })
  .entrypoints();

const app = await defineApp('my-app').infra(database).features([billing]).boot();
if (isFailure(app)) throw new Error(app.code);

// Static graph
console.log(app.manifest.plugins.map(p => p.name).join());
console.log(JSON.stringify(app.manifest.dependencies));

// Runtime snapshot
const snapshot = app.diagnostics;
console.log(snapshot.app.state, snapshot.issues.length);
for (const issue of snapshot.issues) {
  console.error(`[${issue.severity}] ${issue.code}: ${issue.message}`);
  console.error(`  remediation: ${issue.remediation}`);
  console.error(`  docs: ${issue.docsUrl}`);
}
await app.dispose();
```

```text
database,billing
[{"from":"billing","to":"database","kind":"requires","key":"db"}]
booted 0
```

`app.diagnostics` is re-computed on every access, so reading it inside a
healthcheck loop is fine — no caching required by the caller.

## CLI: `dot explain`

`dot explain` prints the manifest:

```sh
# Human-readable
npx dot explain

# JSON (for agents and CI)
npx dot explain --json | jq '.data.manifest.plugins'
```

The CLI **does not boot** the app — it only runs `configure`. This means
`dot explain` is safe on a misconfigured app: it surfaces what was declared
without trying to open resources. It prints one labelled edge per
capability, such as `daily-digest --[db]--> db`. Manifest `dependencies`
entries carry `key`, and manifest `provides` is filled at `configure()`,
adapters included.

### Wiring codes

The kernel checks every unit's needs against every unit's static provides
at `configure()`:

- `ARKI_DOT_E020` — a provider is mounted after its consumer. The fix
  line is role-aware: "Move X before Y in .features([...])." for a feature
  provider, "Mount X with .infra() before Y." for any other unit.
- `ARKI_DOT_E019` — needs and provides form a ring through any units.
  The message prints the ring.
- `ARKI_DOT_E012` — a need at boot that no unit declares (erased or JS
  graphs, dynamic http bundle tokens). It is no longer the code for a plain
  ordering mistake.

Output envelope (`arki.cli/1`, from `@arki/cli`; JSON when piped or with `--json`):

```ts
import type { Envelope } from '@arki/cli';
import type { DotAppManifest } from '@arki/dot';

// What `dot explain --json` prints, read the way an agent reads it.
export function unitNames(envelope: Envelope<DotAppManifest>): readonly string[] {
  if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.remediation ?? envelope.error.message}`);
  return envelope.data?.plugins.map(p => p.name) ?? [];
}
```

`.data` is the `DotAppManifest` itself. When `configure` returns a failure, the envelope
is `ok: false` with the canonical failure code and exit 3. Private causes do
not serialize: an `UnexpectedDefect` has null public data. A compatibility
callback that throws can still produce `dot.app_lifecycle_failed`.

## CLI: `dot doctor`

`dot doctor` boots the app, captures `app.diagnostics`, then disposes:

```sh
# Human-readable
npx dot doctor

# JSON (for agents and CI)
npx dot doctor --json | jq '.data.issues'
```

If a managed boot or disposal phase fails, `dot doctor` **still emits a diagnostics envelope**
populated with the per-unit issues from the configured seam. Boot failure
should be observable, not opaque.

Exit codes:

- `0` — `success` or `warning` envelope (warnings still mean the app booted).
- `1` — `failure` envelope or a structured CLI error (bad args, app not
  found, etc.).

## App discovery

Both commands auto-discover the app by looking for, in order:

1. `--app <path>` if passed.
2. `./dot.config.ts`
3. `./src/app.ts`
4. `./app.ts`

The discovered file must export an app builder, configured app, or booted
app as the default export or as `app`.

## See also

- [Lifecycle](./lifecycle.md) — error codes and state transitions.
- [Agent guide](./agent-guide.md) — using `--json` output from a coding
  agent.
