# RFC: `@arki/log`, rebuilt

- **Status**: accepted (founder, 2026-10-13)
- **Replaces**: the design in the first versions of `plans/packages/007-*.md` and `012-*.md`
- **Sources**: two independent designs, Fable and Astra (blind to each other), merged here. Founder decisions: six levels; Dot gets a logging slot.
- **Builds on**: decision 2 in `docs/rfcs/2026-10-12-dot-core-centred-on-journal.md` §6 (Node logging is switched on explicitly, never by an import).

## 1. Goal

The best logging library in JavaScript, with the best developer experience. It takes ideas from Monolog and Laravel (channels in one config, fingers-crossed buffering, shared and scoped context, a test fake), Serilog (message templates that keep their values as fields), pino (speed, bound fields, redaction), and LogTape (zero dependencies, runs everywhere, libraries log and apps configure). Records map onto the OpenTelemetry log data model.

House rules it must meet: zero dependencies in the core; runs on Node, Bun, Deno, browsers and Hermes; importing does nothing; competitive with pino on the hot path; strict TypeScript with no `any`; pre-1.0, so the breaking change ships as a minor version with no shims.

## 2. The tour

A library logs and configures nothing:

```ts
import { getLogger } from '@arki/log';

const log = getLogger('arki:kv'); // module scope is fine

export async function connect(url: string) {
  log.debug('connecting to {host}', { host: new URL(url).host });
}
```

An app configures once, at its entry file:

```ts
import { configure, redact } from '@arki/log';
import { fromEnv, stdout } from '@arki/log/node';

export const logging = configure({
  resource: { 'service.name': 'checkout', 'service.version': '1.4.0' },
  channels: { stdout: stdout() },
  default: { level: 'info', channels: ['stdout'] },
  categories: { arki: { level: 'warn' } },
  processors: [redact(['password', 'headers.authorization'])],
  ...fromEnv(), // LOG_LEVEL=debug, DEBUG=arki:kv:*
});
```

A Dot app does the same through `log(...)` from `@arki/log/dot` (§9).

## 3. Logger and categories

- `getLogger(category?)` returns a logger. A category is a `:`-separated path (`'arki:dot:lifecycle'`). No argument means the root category `''`. Loggers are memoised per category.
- `log.child('redis')` extends the path (`'arki:kv:redis'`).
- `log.with({ pool: 'main' })` returns a logger with bound fields. It is immutable; the original is unchanged.
- `log.withTrace({ traceId, spanId, traceFlags? })` returns a logger that stamps that trace on every record (for code that has a span context in hand).
- `log.to('slack', 'audit')` sends the next records from that logger to those channels only, instead of the category's channels. It is Laravel's `Log::channel()` / `Log::stack()`.
- **Settings come from the nearest configured ancestor.** `'arki:kv:redis'` uses the `'arki:kv'` rule if there is one, else `'arki'`, else `default`. A rule replaces, it does not add: there is no bubbling and no record is ever delivered twice because two ancestors both have outputs.

## 4. Levels

Six levels, with OpenTelemetry severity numbers (the numbers today's `types.ts` already uses):

```ts
export const Level = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
export type LevelName = keyof typeof Level;
```

Methods: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, plus `log(level, template, fields?)` where `level` is a `LevelName` or a number from 1 to 24, and `isEnabled(level)`. Logging never ends the process: `fatal` only writes.

## 5. Records, templates and fields

### 5.1 Message templates

The first argument is a template. Placeholders are `{name}`; `{{` and `}}` are literal braces. The template is **never** turned into a string on the hot path. Formatters render it later, after redaction, so a secret can never be baked into the message text. The JSON output writes both `template` and the rendered `message`, so logs can be grouped by template.

Placeholders are typed when the template is a literal. A placeholder must be satisfied by the call's fields **or** by fields already bound with `.with()`:

```ts
log.info('user {userId} signed in', { userId: 'usr_1' }); // ok
log.info('user {userId} signed in', { user: 'usr_1' });   // compile error
const order = log.with({ orderId: 'ord_1' });
order.info('charged {orderId}', { amount: 42 });          // ok: orderId is bound
```

A template typed as plain `string` accepts any fields. At runtime, a placeholder with no value renders as `{name}` unchanged.

### 5.2 Fields and values

```ts
type Value =
  | string | number | boolean | null | undefined | bigint | Date | Error
  | readonly Value[] | { readonly [key: string]: Value };
type Fields = { readonly [key: string]: Value };
```

**One field map per record**, as in OpenTelemetry. When keys collide, the later layer wins: shared context, then bound (`.with()`), then scoped (`withContext`), then the call's own fields. Processors may add fields; the built-in `enrich` never overwrites an existing key.

### 5.3 Errors

An `Error` passed under the field key `error`, `err` or `cause` becomes `record.error`. `log.error(err)` and `log.fatal(err)` are also accepted; the template is then the error's message. Serialisation keeps `name`, `message`, `stack`, `code` and own enumerable fields, walks `cause` chains and `AggregateError.errors`, and bounds depth and cycles. It never calls getters.

### 5.4 Lazy values

The level check comes first, so a disabled call evaluates nothing but its arguments. To skip even that, pass a thunk: `log.debug('state {state}', () => ({ state: inspect(big) }))`. The thunk runs once, only when the level is enabled. It is synchronous; if it throws, the record is written with a `log.thunk_error` field instead of being lost.

### 5.5 Structured events

`log.emit({ level, eventName, body, fields? })` writes a record with an OpenTelemetry event name and a structured body instead of a template. Use it for machine-read events (`'payment.accepted'`).

### 5.6 The record

```ts
type LogRecord = Readonly<{
  time: number;          // epoch ms
  level: number;         // 1..24 (OTel SeverityNumber)
  levelName: LevelName;  // OTel SeverityText
  category: string;
  template: string;      // '' for emit() without a template
  eventName?: string;
  body?: Value;
  fields: Fields;
  error?: Error;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  resource: Fields;
  message(): string;     // renders the template on first call, then memoised
}>;
```

## 6. Context

- **Bound**: `log.with(fields)`. Lives on the logger.
- **Scoped**: `await withContext({ requestId }, () => handle(req))`. Every record logged inside carries the fields. It needs a context store. The core ships a synchronous store (correct for synchronous code only). `@arki/log/node` ships `asyncContext()` on `AsyncLocalStorage`, which the app installs with `configure({ context: asyncContext() })`. Browsers and Hermes have no async context, so scopes there are synchronous only. There is no fake global stack that pretends otherwise.
- **Shared**: `shareContext({ region: 'eu-central' })`. App-wide, set by the app.

## 7. The pipeline: processors, channels, sinks, formatters

Order for one record: level check → build record (lazy thunk, context merge, error extraction) → global processors → channel sinks (each sink's own level and processors) → formatter → output.

- **Processor**: `(record: LogRecord) => LogRecord | null`. Returning `null` drops the record. Built-ins in core: `redact(paths, { censor? })`, `enrich(fn)`, `dropWhen(predicate)`. Redaction paths are dot paths with `*` for one level (`'*.token'`), matched against fields and the serialised error. `censor` may be a string or a function.
- **Sink**: the output.

  ```ts
  type Sink = {
    write(record: LogRecord): void;          // synchronous by contract
    flush?(): void | Promise<void>;
    close?(): void | Promise<void>;
    level?: LevelName;                       // the sink's own floor
    processors?: readonly Processor[];       // the sink's own processors
  };
  ```

  A sink that does async IO buffers inside itself. No promise is created per record. A sink may also set `captureFrom` (used by `fingersCrossed`, §7.1).

  **Logging never throws into the code that logs.** A sink that throws loses only its own copy; the other sinks still write. A processor that throws drops the record (it may be the redactor, so writing the record unprocessed could leak). Each failing sink or processor is reported once on `console.error`, never through logging itself. The same holds inside wrapper timers, so a failure there is never an uncaught exception.
- **Channel**: a named sink in `configure({ channels })`. A category rule lists which channels it writes to.
- **JSON line layout**: `time`, `level` (number), `levelName`, `category`, `template`, `message`, then `eventName`, `body`, `fields` (one nested object, each key once), `error`, `traceId`, `spanId`, `traceFlags`, `resource`. Fields are nested so they can never clash with these top-level keys.
- **Processor helper**: processors change a record with `updateRecord(record, changes)`, never with a spread (a spread would keep a stale `message()`).
- **Formatter**: `(record: LogRecord) => string`. Built-ins in core: `json()`, `pretty({ colors? })` (consola-quality human output, placeholders highlighted), `logfmt()`.
- **Core sinks**: `consoleSink({ format? })` (browser mode passes objects so devtools can expand them), `memorySink()`, `lineSink(write, { format? })`.
- **Node sinks** (`@arki/log/node`): `stdout({ format? })`, `stderr(...)`, `file({ path, format? })`. They buffer lines and write with `fs.writeSync` on `setImmediate` or at 16 KiB, and flush synchronously on process exit. The exit hook is registered by the factory call, never at import.

### 7.1 Wrappers (Monolog's best handlers)

Each wraps any sink and returns a sink:

- `fingersCrossed(sink, { triggerAt: 'error', captureFrom: 'debug', maxRecords: 200, scope: 'context' })`. Records from `captureFrom` up are kept in a bounded ring. When a record at `triggerAt` or above arrives, the ring is written in order, then the trigger, then later records in that scope pass straight through. A scope that ends without an error discards its ring. With `scope: 'context'`, there is one ring per `withContext` scope (needs `asyncContext()`); with `scope: 'global'`, one ring for the process. `captureFrom` makes those levels pass the level check for this sink only. It never lowers other sinks' levels.
- `buffer(sink, { maxRecords, flushIntervalMs, overflow: 'drop-oldest' | 'drop-newest' })`. Batching with a size limit and a stated rule for what is dropped when full. Records keep their order.
- `deduplicate(sink, { windowMs, key? })`. The same key (default: level + category + template) is written once per window; when the window closes, a summary record states how many were suppressed.

## 8. Configuration

### 8.1 `configure()` and the handle

```ts
const logging = configure(config);
logging.flush();                   // Promise<void>
logging.close({ timeoutMs });      // flush, close every sink; the instance is unconfigured again
logging.reconfigure(nextConfig);   // Promise: swaps atomically, resolves when old sinks have drained
```

- `config.channels`: `Record<string, Sink>`.
- `config.default`: `{ level, channels }` for the root category.
- `config.categories`: `Record<string, { level?, channels?, inherit? }>`. `inherit: false` makes a category start from no channels instead of its parent's.
- `config.processors`, `config.resource`, `config.context`, `config.trace` (a trace source; `@arki/log/otel` provides one).
- Channel names in `default` and `categories` must exist: a typo is a compile error, and a coded error at runtime for untyped callers.

**One owner.** The package keeps one default `Logging` instance that the global `getLogger`, `configure`, `withContext` and `shareContext` use. A second `configure()` on it throws `ARKI_LOG_E001` (use the handle's `reconfigure`). `createLogging()` returns a private instance with the same functions, for full isolation.

### 8.2 Late binding

A logger holds only its category, its bound fields and a pointer to its `Logging`. The `Logging` has a `version` number that goes up on every `configure`/`reconfigure`. Each logger caches `{ version, minLevel, route }`. A log call compares one integer and refreshes the cache only when the version changed. So the ~170 files that call `getLogger('x')` at module scope obey a `configure()` that runs later.

The default instance lives at `globalThis[Symbol.for('@arki/log/default@1')]`, so two copies of the package in one process share one configuration.

### 8.3 Before `configure()`

The root level is `warn` and there are no sinks. Records at `warn` and above go into a 64-record ring; the first `configure()` writes them through the new channels, then empties the ring. Everything below `warn` is dropped at the level check.

### 8.4 Typed channel names everywhere

`log.to('slack')` is checked against the app's channel names through a register interface (the TanStack Router pattern):

```ts
declare module '@arki/log' {
  interface Register { logging: typeof logging }
}
```

Without the declaration, `to()` accepts any string.

### 8.5 Environment

`fromEnv(env?)` in `@arki/log/node` returns `{ env }`, which `configure()` merges on top of `default` and `categories` (so spreading it never wipes them). It reads, only when called, `LOG_LEVEL` (the default level), `DEBUG` (`arki:kv:*,-arki:kv:noisy`: each match becomes a `debug` level rule on that category; `-` excludes) and `NO_COLOR`. It returns a partial config to spread into `configure()`. Nothing reads the environment at import.

`@arki/log/debug` and the `debug` dependency are removed. `DEBUG=arki:*` keeps working through `fromEnv()`.

## 9. Dot integration

Dot gets an optional **logging slot**. A plugin can declare a logging capability; `log(config)` from `@arki/log/dot` is that plugin.

```ts
import { defineApp } from '@arki/dot';
import { log } from '@arki/log/dot';
import { fromEnv, stdout, asyncContext } from '@arki/log/node';

const app = await defineApp('checkout')
  .use(log(() => ({ ...fromEnv(), context: asyncContext(), channels: { stdout: stdout() }, default: { level: 'info', channels: ['stdout'] } })))
  .boot();
```

- The kernel finds the logging capability when the app is assembled (pure, no IO). It activates logging **before its first lifecycle record** and closes it **after its last** (after `dispose: complete`). On a failed boot, logging closes last, so the original failure is written.
- `resource['service.name']` defaults to the app's name.
- The plugin publishes the `Logging` handle as a typed service.
- It does not read env on its own (pass `fromEnv()`), does not install an OTel SDK, and does not patch `console`.
- The kernel's own logger (`arki:dot:lifecycle`) is an ordinary `getLogger`, so it obeys the app's config.
- Dot's hand-set hook trace context (`packages/dot/src/kernel/otel.ts`, `setTraceContext`) is replaced by the trace source from `@arki/log/otel` or `.withTrace()`.

## 10. OpenTelemetry (`@arki/log/otel`)

- `otelTrace()`: a trace source that reads the active span from `@opentelemetry/api` when a record is built.
- `otelSink(loggerProvider)`: sends records to the OTel Logs API (severity, body or rendered message, attributes, trace ids, resource, `log.category`, `log.template`).
- `@opentelemetry/api` and `@opentelemetry/api-logs` are optional peer dependencies.

## 11. Testing (`@arki/log/testing`)

```ts
import { fakeLog } from '@arki/log/testing';

test('refund over limit alerts', async () => {
  using log = fakeLog(); // level trace, captures every category, restores on dispose

  await refund({ amount: 9000 });

  log.assertLogged({ level: 'error', template: 'refund over limit {amount}', fields: { amount: 9000 } });
  log.assertSentTo('slack', { level: 'error' });
  log.assertNotLogged({ level: 'warn' });
  expect(log.records).toHaveLength(1);
});
```

`fakeLog()` takes over the default instance and gives it back on `restore()` or dispose. Assertions throw with the captured records printed. They work with any test runner. One fake at a time per process (Vitest isolates test files).

## 12. Entry points

| Entry | Holds | May import |
| --- | --- | --- |
| `@arki/log` | `getLogger`, `configure`, `createLogging`, `withContext`, `shareContext`, `Level`, processors, formatters, core sinks, wrappers, types | nothing (web-standard globals only; ESLint guard as in `packages/math`) |
| `@arki/log/node` | `stdout`, `stderr`, `file`, `fromEnv`, `asyncContext` | `node:*`, `process` (runs on Bun and Deno too) |
| `@arki/log/otel` | `otelTrace`, `otelSink` | optional `@opentelemetry/*` peers |
| `@arki/log/dot` | `log()` | `@arki/dot` peer |
| `@arki/log/testing` | `fakeLog` | core |

Removed: `./debug`, the `pino` and `debug` dependencies, `Logger` class, `rootLogger`, `createLogger`, `configuration`, `Configuration`, `LoggingFormatter`, `LogBatch`, `AsyncTransport`, `Severity*`, `Attributes`, `Body`. `pino`, `winston` and `consola` stay as dev dependencies for the benchmark.

## 13. Performance

- Disabled call: one version compare and one level compare, no allocation. Target: no slower than pino's disabled call. (The first draft said "5× faster"; pino's disabled method is an empty function and both sit at the benchmark harness's ~9 ns floor, so that target cannot be measured.)
- Enabled call: one record object; no spreads on the hot path; bound fields serialised once per `.with()` and cached (pino's "chindings" trick); a hand-written JSON writer for flat values; template rendering with a per-template parsed cache (bounded).
- Targets: enabled `info` with fields within 1.2× of pino doing the same output; `.with()` under 300 ns.
- Benchmarks (`bench/log.bench.ts`, `@arki/bench`, contract-checked against pino, winston, consola): disabled, message-only, fields, bound fields, template render, redact on five fields, fingers-crossed with no trigger, real write to `/dev/null` against `pino.destination`.

## 14. Deliberately left out

- Monolog handler bubbling: order-dependent and invisible at the call site. Category rules and per-sink levels cover it.
- Monolog's `context` vs `extra` split: one map, as in OpenTelemetry.
- RFC 5424's nine levels: the founder chose six.
- printf-style `%s` arguments: templates replace them.
- Reading env at import; choosing pretty output from `NODE_ENV`.
- Per-logger `setSeverity`: levels belong to configuration.
- Async lazy values; sinks that return a promise per record.
- A worker-thread sink, a Zod config adapter, an `AsyncLocalStorage`-isolated test fake: later, if needed.
- A Google Cloud formatter (today's `formatter.ts`).

## 15. Build order

1. **Plan 007: the new library, beside the old one.** Core, `/node`, `/testing`, wrappers, ESLint guard, cross-runtime proof, benchmarks. The new core is reachable at a temporary `@arki/log/core` entry; `@arki/log` itself is unchanged.
2. **Plan 012: the switch.** Dot's logging slot, `/dot`, `/otel`. `@arki/log` points at the core; every call site moves; the old code, `./debug`, `./core` and the `pino`/`debug` dependencies go; minor changeset.
