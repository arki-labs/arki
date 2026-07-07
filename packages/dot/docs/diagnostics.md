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
type DotAppManifest = {
  manifestVersion: 2;
  app: { name: string; version?: string };
  pips: PipManifest[];
  actions: ActionManifest[];
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
  projections: ProjectionManifest[];
};
```

**Six-array contract.** The six top-level arrays (`pips`, `actions`,
`services`, `lifecycle`, `dependencies`, `projections`) are **always
present**, even when empty. Consumers must never see an omitted array.

### Sub-shapes

```ts
type PipManifest = {
  name: string;
  version?: string;
  dependencies: readonly string[];
  provides: readonly string[];
};

type ActionManifest = {
  id: string;
  pip: string;
  binding: string;
  direction: 'in' | 'out';
  address?: string;
  summary?: string;
  meta?: JsonObject;
  metaSchema?: string;
};

type ServiceManifest = {
  name: string;
  pip: string;
  kind: 'env' | 'db' | 'kv' | 'queue' | 'auth' | 'email' | 'logger' | 'custom';
};

type LifecycleManifest = {
  pip: string;
  hooks: readonly DotLifecycleHook[];
};

type DependencyEdge = {
  from: string;
  to: string;
  kind: 'requires' | 'provides' | 'uses';
};

type ProjectionManifest = {
  format: string;
  binding: string;
  module: string;
  pip: string;
};
```

## `DotDiagnosticsSnapshot`

A diagnostics snapshot is a point-in-time record. Reading
`app.diagnostics` re-computes it from the kernel's live state.

```ts
type DotDiagnosticsSnapshot = {
  snapshotVersion: 2;
  generatedAt: string; // ISO-8601
  app: { name: string; state: DotLifecycleState };
  pips: PipDiagnostic[];
  actions: ActionDiagnostic[];
  services: ServiceDiagnostic[];
  lifecycle: LifecycleDiagnostic[];
  issues: DiagnosticIssue[];
};
```

**Five-array contract.** Same rule as the manifest — `pips`, `actions`,
`services`, `lifecycle`, `issues` are always present.

### `DiagnosticIssue`

The single actionable record:

```ts
type DiagnosticIssue = {
  code: string;          // stable machine-readable code, e.g. DOT_LIFECYCLE_E003
  severity: 'info' | 'warning' | 'error';
  pip?: string;       // owning pip, when applicable
  message: string;       // human-readable summary
  remediation: string;   // what the developer (or agent) should do
  docsUrl: string;       // link to the relevant doc
  metadata?: Record<string, unknown>;
};
```

Every issue is required to carry `code`, `message`, `remediation`, and
`docsUrl`. Diagnostics are never "something went wrong" — they are always
actionable.

## Programmatic access

```ts
import { defineApp } from '@arki/dot';

const app = await defineApp('my-app').use(/* ... */).boot();

// Static graph
console.log(app.manifest.pips.map(p => p.name));
console.log(app.manifest.dependencies);

// Runtime snapshot
const snapshot = app.diagnostics;
if (snapshot.issues.length > 0) {
  for (const issue of snapshot.issues) {
    console.error(`[${issue.severity}] ${issue.code}: ${issue.message}`);
    console.error(`  remediation: ${issue.remediation}`);
    console.error(`  docs: ${issue.docsUrl}`);
  }
}
```

`app.diagnostics` is re-computed on every access, so reading it inside a
healthcheck loop is fine — no caching required by the caller.

## CLI: `dot explain`

`dot explain` prints the manifest:

```sh
# Human-readable
npx dot explain

# JSON (for agents and CI)
npx dot explain --json | jq '.data.manifest.pips'
```

The CLI **does not boot** the app — it only runs `configure`. This means
`dot explain` is safe on a misconfigured app: it surfaces what was declared
without trying to open resources.

Output envelope:

```ts
type DotCliEnvelope<T> = {
  status: 'success' | 'warning' | 'failure';
  command: string;
  generatedAt: string;
  data: T;
  errors: DiagnosticIssue[];
};
```

`data.manifest` carries the `DotAppManifest`. `errors` is populated when
`configure` fails — the envelope still parses, agents still see the issue.

## CLI: `dot doctor`

`dot doctor` boots the app, captures `app.diagnostics`, then disposes:

```sh
# Human-readable
npx dot doctor

# JSON (for agents and CI)
npx dot doctor --json | jq '.data.diagnostics.issues'
```

If `boot()` throws, `dot doctor` **still emits a diagnostics envelope**
populated with the per-pip issues from the configured seam. Boot failure
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
