# DOT for Agents

DOT treats coding agents as first-class framework users. A well-built agent
should be able to enter a DOT app, understand its runtime graph, run
deterministic checks, make a scoped change, and verify the result — without
diving through implementation details of every package.

This guide is the agent's playbook.

## Why DOT is agent-native

- **Inspectable app graph.** `app.manifest` is structured data: pips,
  services, routes, lifecycle hooks, dependency edges. No prose, no
  source-diving.
- **Structured diagnostics.** Every issue carries a stable `code`,
  `severity`, `message`, `remediation`, and `docsUrl`. Agents read these
  directly.
- **JSON-first CLI.** `dot explain --json` and `dot doctor --json` emit
  envelopes that parse without text scraping.
- **No hidden conventions.** What you see in the manifest is what runs at
  boot. No magic paths.
- **Deterministic generators.** When `dot new` lands (v1.1), it will support
  `--dry-run --json` so agents can preview exact file changes before
  writing.

## 1. Inspect the app graph

Run `dot explain` to get a `DotAppManifest`:

```sh
npx dot explain --json
```

Envelope:

```json
{
  "status": "success",
  "command": "explain",
  "generatedAt": "2026-05-21T08:00:00.000Z",
  "data": {
    "manifest": {
      "app": { "name": "my-app" },
      "pips": [ /* ... */ ],
      "routes": [ /* ... */ ],
      "services": [ /* ... */ ],
      "lifecycle": [ /* ... */ ],
      "dependencies": [ /* ... */ ]
    }
  },
  "errors": []
}
```

Walk the graph from agent code (TypeScript):

```ts
import { defineApp } from '@arki/dot';
import { app } from './app.js'; // your already-defined builder

const configured = (app as ReturnType<typeof defineApp>).configure();
const pips = configured.manifest.pips.map(p => p.name);
const routes = configured.manifest.routes;
```

When invoking the CLI from an agent, prefer `spawn`/`execFile` on
`'npx'` with the args `['dot', 'explain', '--json']` rather than shell
interpolation. The CLI prints the JSON envelope to stdout.

The manifest is the **only authoritative source** for "what does this app
do?". Do not infer this by reading `app.ts` — read the manifest.

## 2. Check runtime health

```sh
npx dot doctor --json
```

Look at `data.diagnostics.issues`:

```json
{
  "data": {
    "diagnostics": {
      "issues": [
        {
          "code": "ENV_E001",
          "severity": "error",
          "pip": "env",
          "message": "Missing required env var: DATABASE_URL",
          "remediation": "Add DATABASE_URL to your environment or .env file.",
          "docsUrl": "https://example.com/dot/docs/diagnostics#env-e001"
        }
      ]
    }
  }
}
```

Each issue is actionable. Agent logic:

```ts
for (const issue of envelope.data.diagnostics.issues) {
  if (issue.severity === 'error') {
    // Read `remediation`. If automatable, apply it. Otherwise report.
  }
}
```

Even if `boot()` fails, `dot doctor` still emits a diagnostics envelope —
boot failure is observable, not opaque.

## 3. Safe code generation

When generating pips, routes, or services:

- **Always validate against the manifest contract** before writing. A
  generated pip must produce a valid `DotManifestContribution`.
- **Use the test harness.** Boot the generated pip in `testApp([...])`
  before claiming the change is done.
- **Prefer adapters over hand-rolled pips.** If a package exposes
  `./dot`, use it.

`dot new <app>` (v1.1) and `dot add <pip>` (deferred) will both support
`--dry-run --json` so agents can preview the exact file operations. Until
those land, agents must use the existing `defineApp(...).use(...)` API
directly and verify with `dot explain`.

## 4. The verification loop

After any change, an agent should run this sequence:

```sh
# 1. Types still check out
npx tsc --noEmit

# 2. Manifest is still well-formed
npx dot explain --json | jq '.status'  # expect "success"

# 3. App still boots and is healthy
npx dot doctor --json | jq '.status'   # expect "success" or "warning"
```

A change is "done" when all three pass. Skipping verification is the
single biggest correlate of broken commits.

## 5. Recipes

### Add an env var

1. Edit the `env({ schema: { ... } })` pip in `app.ts` to add the new
   key.
2. `npx dot explain --json | jq '.data.manifest.services[] | select(.kind == "env")'`
   — confirm the env pip is still registered.
3. `npx dot doctor --json | jq '.data.diagnostics.issues'` — should be
   empty unless the env var is missing at runtime.

### Add a route

1. Edit the pip that owns the route domain. Call `ctx.registerRoute({
   id, method, path, transport })` from its `configure` hook.
2. `npx dot explain --json | jq '.data.manifest.routes'` — confirm the
   route appears with the right pip owner.
3. `npx dot doctor --json | jq '.data.diagnostics.routes'` — confirm
   `status: "ok"`.

### Add a pip

1. Import the pip and chain `.use(pip)` onto the builder in `app.ts`.
2. `npx dot explain --json | jq '.data.manifest.pips'` — confirm the new
   pip is in the list.
3. `npx dot doctor --json | jq '.data.diagnostics.lifecycle'` — confirm
   every hook ran.

### Debug a boot failure

1. `npx dot doctor --json | jq '.data.diagnostics.issues[] | select(.severity == "error")'`.
2. Read the first `remediation`. Apply it.
3. Re-run. Repeat.

If the first issue's `code` is `DOT_LIFECYCLE_E003` (boot failure), the
`pip` field tells you exactly which pip's `boot` threw. The kernel
already cleaned up everything else.

## 6. AGENTS.md convention

Every app generated by `dot new` will include an `AGENTS.md` file at the
app root. This file documents:

- **Verification commands** — the exact `typecheck`, `test`, and `dot
  doctor` commands the agent should run.
- **Local conventions** — naming, file layout, where to put new pips.
- **Public / private boundaries** — which files agents may freely edit and
  which require human review.
- **Where DOT artifacts live** — `dot.config.ts`, `app.ts`, `src/pips/`.

Agents working in a DOT app should **read `AGENTS.md` first**. It is the
contract between the app's author and the agents that will modify it. If
no `AGENTS.md` exists, work conservatively: read the manifest, ask before
editing, and verify every change with the loop above.

> **Status:** the `AGENTS.md` convention is documented in this section and
> emitted by `dot new` in v1. Run `dot new my-app` and the generated
> `AGENTS.md` will document verification commands, public/private
> boundaries, and DOT artifact locations.

## 7. MCP is a future adapter

DOT's CLI JSON output is **consumable by MCP servers**, but the kernel
**does not depend on MCP**. There is no `@arki/dot/mcp` import. There is no
MCP runtime requirement.

An MCP adapter — published separately as something like `@arki/dot-mcp`
when demand emerges — can layer on top of `dot explain --json` and
`dot doctor --json` to expose them as MCP tools. The kernel does not
care.

This keeps the kernel small, lets MCP evolve at its own cadence, and means
DOT works equally well for agents that don't use MCP at all (REPL agents,
CI agents, IDE agents).

## See also

- [Diagnostics](./diagnostics.md) — full manifest + diagnostics contracts.
- [Lifecycle](./lifecycle.md) — every error code that appears in `issues`.
- [Quickstart](./quickstart.md) — the basic boot path agents will see.
