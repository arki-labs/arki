# @arki/log

Zero-dependency structured logging for every JavaScript runtime. Libraries log; apps configure. Message templates keep their values as fields, channels are set in one config, and records map onto the OpenTelemetry log data model. Runs on Node, Bun, Deno, browsers and React Native (Hermes). Importing it does nothing: no env read, no output, no listener.

## Installation

```sh
npm install @arki/log
# or
bun add @arki/log
# or
pnpm add @arki/log
```

## Tour

A library logs and configures nothing:

```ts
import { getLogger } from '@arki/log';

const log = getLogger('arki:kv'); // module scope is fine

export async function connect(url: string) {
  log.debug('connecting to {host}', { host: new URL(url).host });
}
```

An app configures once, in its entry file:

```ts
import { configure, redact } from '@arki/log';
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
```

Before `configure()` runs, only `warn` and above are kept (the first 64 records), and they are written when `configure()` runs. **An app that never configures logging writes nothing else.** A Dot app uses `log()` from `@arki/dot/log` instead (see [Dot](#dot)).

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
log.info('user {userId} signed in', { userId: 'usr_1' }); // ok
log.info('user {userId} signed in', { user: 'usr_1' }); // compile error: userId is missing

const order = log.with({ orderId: 'ord_1' });
order.info('charged {orderId}', { amount: 42 }); // ok: orderId is bound

log.error('payment failed', { error: err }); // `error`, `err` or `cause` becomes record.error
log.error(err); // the template is the error's message
log.debug('state {state}', () => ({ state: inspect(big) })); // runs only when debug is on
log.emit({ level: 'info', eventName: 'payment.accepted', body: { amount: 42 } });
```

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
const logging = configure(config);
await logging.flush();
await logging.close({ timeoutMs: 5000 }); // flush, close every sink, unconfigured again
await logging.reconfigure(nextConfig);
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
import { fakeLog } from '@arki/log/testing';

test('refund over limit alerts', async () => {
  using log = fakeLog(); // captures every category at trace, restores on dispose

  await refund({ amount: 9000 });

  log.assertLogged({ level: 'error', template: 'refund over limit {amount}', fields: { amount: 9000 } });
  log.assertNotLogged({ level: 'warn' });
});
```

## Dot

A Dot app switches logging on with `log()` from `@arki/dot/log`, as its first `.use(...)`. The kernel activates it before its first lifecycle record and closes it after its last one, also on a failed boot. `resource['service.name']` defaults to the app name.

```ts
import { defineApp } from '@arki/dot';
import { log } from '@arki/dot/log';
import { asyncContext, fromEnv, stdout } from '@arki/log/node';

const app = await defineApp('checkout')
  .use(log(() => ({ ...fromEnv(), context: asyncContext(), channels: { stdout: stdout() }, default: { level: 'info', channels: ['stdout'] } })))
  .boot();
```

## Entry points

| Entry | Holds |
| --- | --- |
| `@arki/log` | `getLogger`, `configure`, `createLogging`, `withContext`, `shareContext`, `Level`, processors, formatters, core sinks, wrappers, types |
| `@arki/log/node` | `stdout`, `stderr`, `file`, `fromEnv`, `asyncContext` |
| `@arki/log/otel` | `otelTrace`, `otelSink` |
| `@arki/log/testing` | `fakeLog` |

## Documentation

`@arki/log` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT — see [LICENSE](./LICENSE).
