# @arki/log

Zero-dependency structured logging for every JavaScript runtime. Libraries log; apps configure. Message templates keep their values as fields, channels are set in one config, and records map onto the OpenTelemetry log data model. Importing it does nothing: no env read, no output, no listener.

## Install

```sh
bun add @arki/log
```

## Quick start

A library logs and configures nothing. An app configures once, in its entry file. This file is tested: a password in the fields is censored before any sink sees it.

```ts from="examples/redact-checkout.ts#redact-checkout"
const logging = createLogging();
export const sink = memorySink();

logging.configure({
  channels: { memory: sink },
  default: { level: 'info', channels: ['memory'] },
  processors: [redact(['password'])],
});

/** Logs a sign-in. The password never reaches the sink. */
export function signIn(userId: string, password: string): void {
  logging.getLogger('app:auth').info('user {userId} signed in', { userId, password });
}
```

A real app uses the default instance and a Node sink:

```ts
import { configure, getLogger, redact } from '@arki/log';
import { asyncContext, fromEnv, stdout } from '@arki/log/node';

export const logging = configure({
  ...fromEnv(), // LOG_LEVEL=debug, DEBUG=arki:kv:*
  context: asyncContext(),
  resource: { 'service.name': 'checkout', 'service.version': '1.4.0' },
  channels: { stdout: stdout() },
  default: { level: 'info', channels: ['stdout'] },
  categories: { arki: { level: 'warn' } },
  processors: [redact(['password', 'headers.authorization'])],
});

getLogger('arki:kv').debug('connecting to {host}', { host: 'db.example.com' });
```

Before `configure()` runs, only `warn` and above are kept (the first 64 records), and they are written when `configure()` runs. **An app that never configures logging writes nothing else.** A Dot app uses `log()` from `@arki/dot/log` instead (see [Dot](#dot)).

## When not to use this

- You need log shipping, rotation or retention. Use a sink that hands records to your platform, or a log agent.
- You need a logger that ends the process. `fatal` only writes.
- You want console output with no setup. An unconfigured app writes nothing below `warn`.

## Runtime support

Runs on Node, Bun, Deno, browsers and React Native (Hermes). The core uses web-standard globals only. `@arki/log/node` needs Node-compatible `node:` modules. `@arki/log/otel` needs the optional `@opentelemetry/api` and `@opentelemetry/api-logs` peers.

<!-- runtimes:start -->
| Runtime | Result | Version tested | Date (UTC) |
| --- | --- | --- | --- |
| node | pass | v26.11.1 | 2026-10-17 |
| bun | pass | 1.4.2 | 2026-10-17 |
| deno | pass | 2.9.7 | 2026-10-17 |
| browser | pass | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes | not run | - | 2026-10-17 |
<!-- runtimes:end -->

## Public imports

| Entry | Holds |
| --- | --- |
| `@arki/log` | `getLogger`, `configure`, `createLogging`, `withContext`, `shareContext`, `Level`, `serializeFailure`, `LogError`, `LOG_ERROR_CODES`, processors, formatters, core sinks, wrappers, types |
| `@arki/log/node` | `stdout`, `stderr`, `file`, `fromEnv`, `asyncContext` |
| `@arki/log/otel` | `otelTrace`, `otelSink` |
| `@arki/log/testing` | `fakeLog` |

## Failure behaviour

Logging never throws into the code that logs. A failing sink loses only its own copy of the record. The failure is reported once on `console.error`.

A setup mistake throws `LogError` with a code and a `remediation`:

| Code | Cause | Fix |
| --- | --- | --- |
| `ARKI_LOG_E001` | `configure()` ran twice | Call it once; use `reconfigure()` on the handle |
| `ARKI_LOG_E002` | A rule or `to()` names an undefined channel | Add the channel to `configure({ channels })` |
| `ARKI_LOG_E003` | A level that does not exist | Use one of the six names or a number from 1 to 24 |
| `ARKI_LOG_E004` | `fakeLog()` while another fake is active | Restore the first fake |
| `ARKI_LOG_E005` | `reconfigure()` on a stale handle | Use the handle from the latest `configure()` |

Fix the setup. Do not catch a `LogError` and carry on: the next call fails the same way.

## Limits

- Before `configure()`, only `warn` and above are kept, and only the first 64 records. The 65th early `warn` is lost.
- `configure()` runs once per instance. A second call throws `ARKI_LOG_E001`.
- A failure value logged as a field prints at most 64 links of its cause chain, then `[MaxDepth]`. A cycle prints `[Circular]`.
- Async code keeps `withContext` fields only when `asyncContext()` from `@arki/log/node` is in `configure()`.
- `fatal` writes a record. It never ends the process.
- A processor changes a record. It cannot change the template text after formatters render it, so redact fields, not messages.

## Loggers and categories

- `getLogger('arki:kv')` returns a logger for a `:`-separated category. Loggers obey a `configure()` that runs later.
- `log.child('redis')` extends the category: `arki:kv:redis`.
- `log.with({ pool: 'main' })` returns a logger with bound fields. The original is unchanged.
- `log.withTrace({ traceId, spanId })` stamps a trace on every record.
- `log.to('audit')` sends the next records to those channels only.
- A category uses the rule of its nearest configured ancestor (`arki:kv:redis` → `arki:kv` → `arki` → `default`). A rule replaces, it never adds, so no record is written twice.

## Levels

Six levels with OpenTelemetry severity numbers: `trace` 1, `debug` 5, `info` 9, `warn` 13, `error` 17, `fatal` 21. Methods: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `log(level, template, fields?)` and `isEnabled(level)`. `fatal` only writes; it never ends the process.

## Templates and fields

```ts
import { inspect } from 'node:util';

import { getLogger } from '@arki/log';

const log = getLogger('app:orders');
const err = new Error('card declined');
const big = { items: [1, 2, 3] };

log.info('user {userId} signed in', { userId: 'usr_1' });

const order = log.with({ orderId: 'ord_1' });
order.info('charged {orderId}', { amount: 42 }); // orderId is bound

log.error('payment failed', { error: err }); // `error`, `err` or `cause` becomes record.error
log.error(err); // the template is the error's message
log.debug('state {state}', () => ({ state: inspect(big) })); // runs only when debug is on
log.emit({ level: 'info', eventName: 'payment.accepted', body: { amount: 42 } });
```

A template field with no value is a compile error: `log.info('user {userId} signed in', { user: 'usr_1' })` does not compile because `userId` is missing.

A failure value from [`@arki/failure`](../failure) is a field like any other: `log.warn('lookup failed', { failure })`. It prints `code`, `message`, `status`, `data` and `remediation`, plus `causes`: the cause chain, nearest first, through nested failures and thrown errors. The list stops at a cycle or after 64 links, the same limit as `findCause`. `@arki/log` knows a failure by its `'~failure'` brand, so it still has no dependencies. `serializeFailure(failure)` returns the same plain fields.

The template is never turned into a string on the hot path. Formatters render it after redaction, so a secret cannot end up in the message text. `{{` and `}}` are literal braces.

## Context

- Bound: `log.with(fields)`.
- Scoped: `await withContext({ requestId }, () => handle(req))`. Async code needs `asyncContext()` from `@arki/log/node` in `configure()`.
- Shared: `shareContext({ region: 'eu-central' })`, app-wide.

## Channels, sinks, formatters, processors

- Core sinks: `consoleSink({ format? })`, `memorySink()`, `lineSink(write, { format? })`.
- Node sinks (`@arki/log/node`): `stdout({ format? })`, `stderr({ format? })`, `file({ path, format? })`. They buffer lines and flush synchronously on process exit.
- Formatters: `json()` (the default), `pretty({ colors? })`, `logfmt()`.
- Processors: `redact(paths, { censor? })`, `enrich(fn)`, `dropWhen(predicate)`. A processor changes a record with `updateRecord(record, changes)`.
- A sink may set its own `level` and `processors`. Logging never throws into the code that logs: a failing sink loses only its own copy, and the failure is reported once on `console.error`.

## Wrappers

- `fingersCrossed(sink, { triggerAt: 'error', captureFrom: 'debug', maxRecords: 200, scope: 'context' })`: keeps records in a ring and writes them only when an error arrives.
- `buffer(sink, { maxRecords, flushIntervalMs, overflow: 'drop-oldest' | 'drop-newest' })`: batches records.
- `deduplicate(sink, { windowMs, key? })`: writes the same record once per window, then a summary.

## The handle

```ts
import { configure, memorySink } from '@arki/log';

const sink = memorySink();
const logging = configure({ channels: { memory: sink }, default: { level: 'info', channels: ['memory'] } });
await logging.flush();
await logging.reconfigure({ channels: { memory: sink }, default: { level: 'debug', channels: ['memory'] } });
await logging.close({ timeoutMs: 5000 }); // flush, close every sink, unconfigured again
```

A second `configure()` throws `ARKI_LOG_E001`; use `reconfigure`. `createLogging()` returns a private instance. Declare `interface Register { logging: typeof logging }` in `declare module '@arki/log'` to type-check channel names in `to()`.

## Environment

Nothing reads the environment on import. `fromEnv()` from `@arki/log/node` reads, when called:

- `LOG_LEVEL`: the default level.
- `DEBUG`: `arki:kv:*,-arki:kv:noisy` turns matching categories to `debug`; `-` excludes.
- `NO_COLOR`.

## OpenTelemetry (`@arki/log/otel`)

- `otelTrace()`: a trace source for `configure({ trace })` that reads the active span when a record is built.
- `otelSink(loggerProvider)`: sends records to the OpenTelemetry Logs API.

`@opentelemetry/api` and `@opentelemetry/api-logs` are optional peer dependencies.

## Testing (`@arki/log/testing`)

```ts
import { test } from 'vitest';

import { getLogger } from '@arki/log';
import { fakeLog } from '@arki/log/testing';

async function refund(input: { amount: number }): Promise<void> {
  getLogger('app:refunds').error('refund over limit {amount}', { amount: input.amount });
}

test('refund over limit alerts', async () => {
  using log = fakeLog(); // captures every category at trace, restores on dispose

  await refund({ amount: 9000 });

  log.assertLogged({ level: 'error', template: 'refund over limit {amount}', fields: { amount: 9000 } });
  log.assertNotLogged({ level: 'warn' });
});
```

## Dot

A Dot app switches logging on with `log()` from `@arki/dot/log`, as its first `.use(...)`. The kernel activates it before its first lifecycle record and closes it after its last one, also on a failed boot. `resource['service.name']` defaults to the app name.

```ts skip="@arki/dot is not a dependency of @arki/log"
import { defineApp } from '@arki/dot';
import { log } from '@arki/dot/log';
import { asyncContext, fromEnv, stdout } from '@arki/log/node';

const app = await defineApp('checkout')
  .use(log(() => ({ ...fromEnv(), context: asyncContext(), channels: { stdout: stdout() }, default: { level: 'info', channels: ['stdout'] } })))
  .boot();
```

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [Upgrade 0.1.0 to 0.2.0](docs/upgrades/0.1.0-to-0.2.0.md): what broke and how to migrate.
- Composing with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot) framework: see its `docs/` for plugin authoring, lifecycle and diagnostics.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).

<!-- bench:start -->
## Benchmarks

Logging a line to an in-process sink with `@arki/log`, against pino (which it wraps), winston and consola. Pino is the speed reference for structured JSON logging in Node; winston and consola are the other widely used loggers.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### info: message + 3 fields

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/log logger.info(msg, fields) | 2.16 µs | 1.60× |
| pino log.info(fields, msg) (used directly) | 2.53 µs | 1.87× |
| winston log.info(msg, fields) | 6.45 µs | 4.78× |
| consola log.info(msg, fields) | 1.35 µs | fastest |

### info: message only

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/log logger.info(msg) | 1.47 µs | 1.76× |
| pino log.info(msg) (used directly) | 834.4 ns | fastest |
| winston log.info(msg) | 5.63 µs | 6.75× |
| consola log.info(msg) | 1.59 µs | 1.91× |

### debug call while the level is info (disabled)

The call is dropped before anything is built. This is the cost of leaving debug logging in hot code.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/log logger.debug(msg, fields) | 22.9 ns | fastest |
| pino log.debug(fields, msg) (used directly) | 119.1 ns | 5.19× |
| winston log.debug(msg, fields) | 24.40 µs | 1064.03× |
| consola log.debug(msg, fields) | 177.7 ns | 7.75× |

### Create a child logger with one bound field

The usual per-request or per-module pattern. consola has no bound fields, so its row uses `withTag` (a name only).

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/log logger.child(name, fields) | 278.7 ns | fastest |
| pino log.child(bindings) (used directly) | 571.7 ns | 2.05× |
| winston log.child(meta) | 848.2 ns | 3.04× |
| consola log.withTag(name) | 15.12 µs | 54.24× |

Read the rows with the contracts in mind:

- Every logger writes JSON to a sink that drops its output. `@arki/log` builds its own pino instance that writes to stdout, so the benchmark swaps `configuration.transport` for an identical pino instance (same options) that writes to the sink. Batching is off, which is the default.
- The JSON differs. `@arki/log` wraps each call in a record (name, body, attributes, severity number and text, timestamp, trace ids) before handing it to pino. That is the structured contract the package sells, and it is the extra work in the rows below. Direct pino, winston and consola write only the message and the fields.
- Pino is used the way its docs show (fields first, then the message), with `base: null` to match `@arki/log`. Winston has the timestamp and JSON formats on. Consola has one reporter that writes `JSON.stringify` of the entry. winston writes through a stream, so its cost includes that.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).
