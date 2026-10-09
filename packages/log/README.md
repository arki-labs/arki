# @arki/log

Structured logging primitives for ARKI — severity levels, batching, distributed-tracing hooks, and Pino-backed transports.

## Installation

```sh
npm install @arki/log
# or
bun add @arki/log
# or
pnpm add @arki/log
```

## Usage

### Basic logging

```ts
import { Logger } from '@arki/log';

const logger = new Logger('my-service');

logger.info('Application started');
logger.debug('Debug information', { userId: 'usr_123' });
logger.warn('Resource running low', { resource: 'memory', available: '10%' });
logger.error('Failed to process request', { error: new Error('Connection refused') });
```

### Root logger and child loggers

```ts
import { createLogger, rootLogger } from '@arki/log';

rootLogger.info('Application starting');

const apiLogger = createLogger('api');
apiLogger.info('API initialized');

const userLogger = apiLogger.child('user');
userLogger.info('User logged in', { userId: 'usr_123' });
```

### Global configuration

```ts
import { configuration } from '@arki/log';

configuration.setDebug('api,database,auth');

configuration.configureBatching({
  batchLogging: true,
  maxBatchSize: 50,
  autoFlushMs: 3000,
});
```

### Batched logging

```ts
import { Logger } from '@arki/log';

const logger = new Logger('billing');
logger.enableBatchLogging();

logger.info('Event 1');
logger.info('Event 2');

await logger.flush();
await logger.disableBatchLogging();
```

### Distributed tracing

```ts
import { Logger } from '@arki/log';

const logger = new Logger('service-a');
logger.setTraceContext('trace-abc', 'span-1');

logger.info('Processing request', { requestId: 'req_123' });

const childLogger = logger.child('sub-component');
childLogger.info('Sub-component processing');
```

### `debug` adapter

The `@arki/log/debug` entry re-exports the `debug` package as a default + named export for ergonomic namespacing:

```ts
import debug from '@arki/log/debug';

const log = debug('acme:billing');
log('charge', { amount: 1000 });
```

## Environment variables

- `DEBUG` — comma-separated namespace patterns to set to DEBUG level.
- `LOG_LEVEL` — default severity (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`).
- `NODE_ENV` — when `production`, switches to production-formatted output.
- `SERVICE_NAME` / `SERVICE_CONTEXT_NAME` / `HOSTNAME` — service identity for Cloud Logging.
- `SERVICE_CONTEXT_VERSION` — service version for Cloud Logging.

## API

- `Logger` — main class. Methods: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `child`, `withAttribute`, `setSeverity`, `setTraceContext`, `enableBatchLogging`, `disableBatchLogging`, `flush`.
- `rootLogger` — process-wide singleton.
- `createLogger(name, attributes?)` — named child of the root logger.
- `configuration` — global config with `setDebug`, `configureBatching`, `getSeverity`, etc.
- `Severity`, `SeverityName` — severity-level constants.
- `AsyncTransport` — interface for async log sinks.
- `LogRecord`, `Attributes`, `Body`, `SeverityKind`, `SeverityText` — core types.

## Documentation

`@arki/log` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT — see [LICENSE](./LICENSE).
