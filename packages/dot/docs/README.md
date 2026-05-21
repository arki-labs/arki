# DOT Documentation

`@arki/dot` is a TypeScript-first application composition framework. These
docs are organised by job — pick the one that matches what you are about to
do.

## Read first

- [Principles](./principles.md) — the five rules every API, error message,
  and PR is measured against. Read these before contributing.

## For app authors

- [Quickstart](./quickstart.md) — boot your first DOT app in five minutes.
- [Pip authoring](./pip-authoring.md) — write your own `DotPip`.
- [Lifecycle](./lifecycle.md) — the 5-hook contract, failure ordering,
  idempotency rules.
- [Diagnostics](./diagnostics.md) — `app.manifest`, `app.diagnostics`, the
  `dot explain` and `dot doctor` CLI commands.
- [Observability](./observability.md) — OTel-first traces + metrics, the
  `arki:dot:lifecycle` logger, trace/log correlation, zero-cost-when-off.

## For package authors

- [Adapter authoring](./adapter-authoring.md) — expose your package as a DOT
  pip via a `./dot` subpath export.

## For agents

- [Agent guide](./agent-guide.md) — how a coding agent inspects, modifies,
  and verifies a DOT app without source-diving.
- [`llms.txt`](../llms.txt) — agent-discoverable index of all docs.

## For maintainers

- [Release policy](./release-policy.md) — SemVer, deprecation, stability.
- [Upgrade guide](./upgrade-guide.md) — migrating across breaking changes.

## Worked examples

- [`examples/quickstart.ts`](./examples/quickstart.ts) — the complete
  `defineApp(...).use(...).boot()` example used by the quickstart and by the
  release-tooling fixture matrix.
