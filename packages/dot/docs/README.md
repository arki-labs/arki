# Dot documentation

`@arki/dot` composes an app from typed units. These pages are small and
organised by job. Pick the one that matches what you are about to do.

```text
 new here?   principles → quickstart → di → unit-authoring
 shipping?   operations → recipes/deploy → recipes/upgrade
 an agent?   ../llms.txt → agent-guide
```

## Read first

- [Principles](./principles.md): the five rules every API, error message and
  PR is measured against.
- [Composition doctrine](./composition-doctrine.md): declaration-first rules
  for structuring an app and its features.

## For app authors

- [Quickstart](./quickstart.md): build an app, break it on purpose, read the
  error, inspect it with `dot explain` and `dot doctor`.
- [Dependency injection](./di.md): needs, provides, handles, tokens, `rename`,
  lazy services and `defineFeature`.
- [Steps and arounds](./middleware.md): wrap a handler once for every
  transport, and watch every handler with handler events.
- [A complex setup](./complex-setup.md): a many-unit app and the order it
  boots in.
- [Unit authoring](./unit-authoring.md): write your own unit.
- [Lifecycle](./lifecycle.md): the five hooks, failure order, idempotency.
- [Testing units](./testing.md): `testUnit` against fakes, `testApp`
  across real units.
- [Logging, shutdown and timeouts](./operations.md): `log()`, `hookSignals`,
  `createAppRuntime`, `hookTimeoutMs`.
- [Diagnostics](./diagnostics.md): `app.manifest`, `app.diagnostics` and the
  JSON they print.
- [Observability](./observability.md): OpenTelemetry traces and metrics, the
  `arki:dot:lifecycle` logger.
- [The `dot` command](./cli.md): `dot new`, `dot explain`, `dot doctor`,
  `dot dev`.

## Recipes

Each recipe ends in one command and its expected output.

- [Deploy an app](./recipes/deploy.md): build the container, run it, check
  `/api/health`.
- [Upgrade Dot](./recipes/upgrade.md): bump, typecheck, boot-check.

## For package authors

- [Adapter authoring](./adapter-authoring.md): expose your package as a Dot
  unit through a `./dot` subpath export.

## For agents

- [`llms.txt`](../llms.txt): the map. Read it first.
- [Agent guide](./agent-guide.md): inspect, change and verify a Dot app
  without reading the source.
- [`AGENTS.md`](../AGENTS.md): the laws for changing this package.

## For maintainers

- [Release policy](./release-policy.md): SemVer, deprecation, stability.
- [Upgrade guide](./upgrade-guide.md): before and after code for each
  breaking change.

## Worked example

- [`examples/quickstart.ts`](./examples/quickstart.ts): the quickstart app.
  `src/tests/quickstart-example.test.ts` boots it, and the quickstart runs
  `dot explain` and `dot doctor` on it.

- [Action boundaries](./actions.md): shared contracts, native adapters and authority.
- [Upgrade action boundaries](./upgrade-actions.md): typed failures and validation ownership.
