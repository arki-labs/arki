# @arki/log for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/core/index.ts` wins.

## The model

1. A **logger** is `getLogger('arki:kv')`. Its category is `:`-separated. It obeys a `configure()` that runs later.
2. A **record** has a template, fields, a level and a resource. Values stay fields. Formatters render the text.
3. A **channel** is a named sink. A **rule** maps a category to a level and channels. The nearest configured ancestor wins and replaces.
4. **Processors** (`redact`, `enrich`, `dropWhen`) change or drop a record before a sink sees it.
5. **Wrappers** (`fingersCrossed`, `buffer`, `deduplicate`) sit around a sink.
6. The core has no dependencies. `@arki/log/node` adds sinks and env. `@arki/log/otel` adds OpenTelemetry. `@arki/log/testing` adds `fakeLog`.

## Task map

### Log from a library

```ts
import { getLogger } from '@arki/log';

const log = getLogger('arki:kv'); // module scope is fine

export function connect(url: string): void {
  log.debug('connecting to {host}', { host: new URL(url).host });
}
```

Never call `configure()` in a library.

### Configure logging in an app

Call `configure()` once at the entry file. See the [README quick start](../README.md#quick-start).

### Keep secrets out of records

Add `redact(['password', 'headers.authorization'])` to `processors`. Redaction runs before any formatter.

### Test that code logs

```ts
import { test } from 'vitest';

import { getLogger } from '@arki/log';
import { fakeLog } from '@arki/log/testing';

test('logs a warning', () => {
  using log = fakeLog();
  getLogger('app:jobs').warn('job {id} is late', { id: 'job_1' });
  log.assertLogged({ level: 'warn', template: 'job {id} is late' });
});
```

## Rules that bite

- Before `configure()`, only `warn` and above are kept, and only the first 64 records.
- A second `configure()` throws `ARKI_LOG_E001`. Use `reconfigure()` on the handle. App entries pass `{ owner: import.meta.url }`, so a dev server's re-run of the entry replaces the setup instead of throwing.
- `withContext` fields cross `await` only with `asyncContext()` from `@arki/log/node`.
- Context and trace-provider faults omit metadata. `withContext` preserves its callback's exact value, promise or error and calls it once even if the provider fails.
- Sink writes and lifecycle calls are best effort. Rejections are observed; failed flushes still permit close and cannot skip other sinks' cleanup. A close timeout bounds waiting, while cleanup continues.
- Deferred descriptor writes and failure diagnostics cannot throw into application work. Logging does not acknowledge record delivery.
- A failure value logged as a field prints its cause chain, at most 64 links.
- `fatal` never ends the process.
- Importing `@arki/log/node` reads nothing. `fromEnv()` reads `LOG_LEVEL`, `DEBUG` and `NO_COLOR` when called.

## Errors

| Code            | Meaning                                     | What to do                          |
| --------------- | ------------------------------------------- | ----------------------------------- |
| `ARKI_LOG_E001` | `configure()` ran twice                     | Call it once; use `reconfigure()`   |
| `ARKI_LOG_E002` | A rule or `to()` names an undefined channel | Add it to `configure({ channels })` |
| `ARKI_LOG_E003` | A level that does not exist                 | Use one of the six names or 1 to 24 |
| `ARKI_LOG_E004` | `fakeLog()` while another fake is active    | Restore the first fake              |
| `ARKI_LOG_E005` | `reconfigure()` on a stale handle           | Use the latest handle               |

## Verify

```sh
bun run test
bun run test:docs
bun run test:runtimes
```
