# @arki/log

## 0.3.0

### Minor Changes

- 69479f8: `maskSecrets(values)` processor: replaces every occurrence of a known secret value (8+ characters) in the template, string fields at any depth, the serialised error and the body. Pairs with `secretValues` from `@arki/env/node`: `processors: [maskSecrets(secretValues)]`. Also exports `MIN_SECRET_LENGTH`.

## 0.2.0

### Minor Changes

- c7720e1: A failure value from `@arki/failure` can be logged as a field: `log.warn('lookup failed', { failure })`. Every formatter and the OpenTelemetry sink print its `code`, `message`, `status`, `data` and `remediation`, plus `causes`: the cause chain, nearest first, through nested failures and thrown errors. The list stops at a cycle (`[Circular]`) or after 64 links (`[MaxDepth]`), the same limit as `findCause`. `redact()` paths reach into a failure's data and causes. `@arki/log` still has no dependencies: it knows a failure by its `'~failure'` brand. New exports: `serializeFailure` and the `FailureLike` type, which is now part of `Value`.
- 4913009: Security: outside data can no longer pass as a failure. `isFailure` (and `@arki/log`'s failure check) now require the `~failure` brand on the value's prototype and refuse it as an own property. Before, JSON such as `{"~failure": true, "code": "x", "status": 500}` from an API response, queue message or tool result counted as a failure, so boundaries skipped output schemas and answered with an attacker-chosen status or code. Real failures, revived ones and failures from a second copy of the package are still recognised.
- e61afc2: `configure(config, { owner })`: an app entry can now run again in the same process without `ARKI_LOG_E001`. Nitro's dev worker re-imports the server entry after an edit and never runs `import.meta.hot` dispose hooks, so the second `configure()` threw and every page returned 500. When both calls pass the same `owner` (use `import.meta.url`), the second call replaces the setup, closes the old sinks, and makes the old handle stale. Any other second `configure()` still throws `ARKI_LOG_E001`. New type: `ConfigureOptions`.

### Patch Changes

- fe5a391: README follows the docs standard (install, quick start from a tested example, limits, failure behaviour), with `llms.txt`, an agent guide, `AGENTS.md`, `test:docs` and the 0.1.0 to 0.2.0 upgrade guide. `ARKI_LOG_E001` to `E005` gain `@fix` and `@verify` tags.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

## 0.1.0

### Minor Changes

- 2854df5: `@arki/log` is rebuilt. It has zero dependencies, runs on Node, Bun, Deno, browsers and React Native, and importing it does nothing: no env read, no output, no listener. Libraries log with `getLogger('arki:...')`; apps switch logging on once, in their entry file.

  **Apps must now switch logging on.** Until an app calls `configure()` (or mounts `log()` in a Dot app), only the first 64 records at `warn` and above are kept, and nothing else is written.

  ```ts
  import { configure } from '@arki/log';
  import { asyncContext, fromEnv, stdout } from '@arki/log/node';

  configure({
    ...fromEnv(), // LOG_LEVEL, DEBUG=arki:kv:*
    context: asyncContext(),
    channels: { stdout: stdout() },
    default: { level: 'info', channels: ['stdout'] },
  });
  ```

  A Dot app does the same as its first `.use(...)`:

  ```ts
  import { log } from '@arki/dot/log';

  defineApp('checkout').use(
    log(() => ({
      ...fromEnv(),
      context: asyncContext(),
      channels: { stdout: stdout() },
      default: { level: 'info', channels: ['stdout'] },
    })),
  );
  ```

  How to migrate a call site:

  | Before                               | After                                                                                 |
  | ------------------------------------ | ------------------------------------------------------------------------------------- |
  | `createLogger('x')`                  | `getLogger('x')`                                                                      |
  | `createLogger('x', attrs)`           | `getLogger('x').with(attrs)`                                                          |
  | `new Logger(name, attrs)`            | `getLogger(name).with(attrs)`                                                         |
  | `.withAttribute(k, v)`               | `.with({ [k]: v })`                                                                   |
  | `.child(name, attrs)`                | `.child(name).with(attrs)`                                                            |
  | `log.info('text', attrs)`            | unchanged (the text is now a template; `{name}` reads a field)                        |
  | `log.info({ ...object })`            | `log.emit({ level: 'info', eventName: '<category>.<what>', body: {...} })`            |
  | `log.warn(err)`                      | `log.warn('<what failed>', { error: err })`                                           |
  | `debug('ns')` from `@arki/log/debug` | `getLogger('ns')`, then `.debug('text {field}', { field })` instead of `%s` arguments |
  | `Attributes`, `Body` types           | `Fields`; a `Body` caller uses a string or `emit`                                     |

  Removed: `@arki/log/debug`, `@arki/log/core` (now `@arki/log` itself), the `Logger` class, `rootLogger`, `createLogger`, `configuration`, batching, the Google Cloud formatter, and the `pino` and `debug` dependencies. `DEBUG=arki:*` still works through `fromEnv()`.

  New entry points: `@arki/log/node` (`stdout`, `stderr`, `file`, `fromEnv`, `asyncContext`), `@arki/log/otel` (`otelTrace`, `otelSink`; the `@opentelemetry/*` packages are optional peers) and `@arki/log/testing` (`fakeLog`).

  `@arki/dot`: plugins can fill a new logging slot (`plugin({ logging: ({ appName }) => handle })`). The kernel switches logging on before its first lifecycle record and closes it after its last one, also when boot fails. Two logging plugins in one app is `DOT_LIFECYCLE_E018`. `@arki/dot/log` exports `log()`, which fills the slot, names the service after the app and publishes the handle as the `logging` service. Hook spans now stamp their trace on log records through `@arki/log`, and importing `@arki/dot` reads no env and writes nothing.

## 0.0.3

### Patch Changes

- Dependency refresh: `pino` ^10.4.0. No API changes.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
