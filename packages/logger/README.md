# @arki/logger

A flexible, structured logging library for Node.js applications with support for batching, distributed tracing, and framework integrations.

## Features

- **Severity Levels**: TRACE, DEBUG, INFO, WARN, ERROR, FATAL
- **Structured Logging**: Standardized log format with support for attributes
- **Batch Logging**: Optional batching for higher performance
- **Framework Integrations**: Express middleware and tRPC middleware
- **Distributed Tracing**: Support for trace context propagation
- **Child Loggers**: Create loggers with hierarchical naming and inheritance
- **Production-Ready**: Formatter for Cloud Logging compatibility

## Installation

```bash
npm install @arki/logger
# or
yarn add @arki/logger
# or
pnpm add @arki/logger
```

## Basic Usage

```typescript
import { Logger } from '@arki/logger';

// Create a logger instance
const logger = new Logger('my-service');

// Log at different severity levels
logger.info('Application started');
logger.debug('Debug information', { userId: '123' });
logger.warn('Resource running low', { resource: 'memory', available: '10%' });
logger.error('Failed to process request', { error: new Error('Connection refused') });

// Create a child logger
const userLogger = logger.child('user');
userLogger.info('User logged in', { userId: '123' });
```

## Using the Root Logger

For convenience, a root logger singleton is provided:

```typescript
import { createLogger, rootLogger } from '@arki/logger';

// Use the root logger directly
rootLogger.info('Application starting');

// Create named loggers from the root logger
const apiLogger = createLogger('api');
apiLogger.info('API initialized');
```

## Configuration

The logger can be configured globally:

```typescript
import { configuration } from '@arki/logger';

// Set debug namespaces
configuration.setDebug('api,database,auth');

// Configure batch logging
configuration.configureBatching({
  batchLogging: true, // Enable batch logging globally
  maxBatchSize: 50, // Flush after 50 records
  autoFlushMs: 3000, // Flush after 3 seconds
});
```

## Environment Variables

The logger responds to these environment variables:

- `DEBUG`: Comma-separated list of namespace patterns to set to DEBUG level
- `LOG_LEVEL`: Default severity level (TRACE, DEBUG, INFO, WARN, ERROR, FATAL)
- `NODE_ENV`: When set to "production", enables production formatting
- `SERVICE_NAME` or `SERVICE_CONTEXT_NAME`: Service name for Cloud Logging
- `SERVICE_CONTEXT_VERSION`: Service version for Cloud Logging

## Batch Logging

Batch logging can significantly improve performance by reducing I/O operations.

### Enabling Batch Logging

```typescript
import { configuration, Logger } from '@arki/logger';

// Enable globally (affects all new loggers)
configuration.configureBatching({ batchLogging: true });

// Or enable for a specific logger
const logger = new Logger('my-service');
logger.enableBatchLogging();

// Log normally - messages will be batched
logger.info('This message is batched');
logger.info('This message is also batched');

// Manually flush when needed
await logger.flush();

// Disable batching when no longer needed
await logger.disableBatchLogging();
```

## Express Integration

```typescript
import express from 'express';

import { createLogger, expressLogger } from '@arki/logger';

const app = express();
const logger = createLogger('api');

// Add the logger middleware
app.use(
  expressLogger(logger, {
    logBody: true, // Log request bodies
    logHeaders: false, // Don't log headers
    attributes: {
      // Add custom attributes
      environment: 'production',
    },
  }),
);

app.get('/users', (req, res) => {
  // Access the logger via req.logger if needed
  req.logger.debug('Fetching users');

  res.json({ users: [] });
});

app.listen(3000, () => {
  logger.info('Server started on port 3000');
});
```

## tRPC Integration

```typescript
import { initTRPC } from '@trpc/server';

import { createLogger, createTRPCLoggerMiddleware } from '@arki/logger';

const logger = createLogger('trpc-api');

// Initialize tRPC
const t = initTRPC.create();

// Create the logger middleware
const loggerMiddleware = createTRPCLoggerMiddleware(logger, {
  logInput: true, // Log procedure inputs
  logResponse: false, // Don't log responses (can be large)
});

// Export middleware and procedure
export const middleware = t.middleware;
export const publicProcedure = t.procedure.use(loggerMiddleware);

// Use in a procedure
export const userRouter = t.router({
  getUser: publicProcedure.input(z.string()).query(async ({ input, ctx }) => {
    // Access logger from context
    ctx.logger.info('Getting user', { userId: input });

    return { id: input, name: 'User' };
  }),
});
```

## Distributed Tracing

The logger supports trace context propagation for distributed tracing:

```typescript
import { randomUUID } from 'crypto';

import { Logger } from '@arki/logger';

// Create a logger with trace context
const logger = new Logger('service-a');
const traceId = randomUUID();
logger.setTraceContext(traceId, 'span-1');

// Log with trace context
logger.info('Processing request', { requestId: '123' });

// Create a child logger that inherits trace context
const childLogger = logger.child('sub-component');
childLogger.info('Sub-component processing'); // Has same trace context
```

## Additional Features

### Logger with Context

```typescript
import { Logger } from '@arki/logger';

const logger = new Logger('auth');

// Create a logger with user context
const userLogger = logger.withAttribute('userId', '123').withAttribute('role', 'admin');

userLogger.info('User action performed');
// Logs with attributes: { userId: '123', role: 'admin' }
```

### Custom Transport

For advanced use cases, you can access the underlying Pino transport:

```typescript
import pino from 'pino';

import { configuration } from '@arki/logger';

// Create a custom transport
const transport = pino.transport({
  target: 'pino/file',
  options: { destination: '/var/log/app.log' },
});

// Replace the default transport
configuration.transport = transport;
```

## API Reference

### Logger

```typescript
class Logger {
  constructor(name?: string, attributes?: Attributes);

  // Log methods
  trace(body: Body, attributes?: Attributes): void;
  debug(body: Body, attributes?: Attributes): void;
  info(body: Body, attributes?: Attributes): void;
  warn(body: Body, attributes?: Attributes): void;
  error(body: Body, attributes?: Attributes): void;
  fatal(body: Body, attributes?: Attributes): void;

  // Logger creation
  child(name: string, attributes?: Attributes): Logger;
  withAttribute(key: string, value: any): Logger;

  // Severity
  setSeverity(severity: SeverityKind): void;

  // Tracing
  setTraceContext(traceId: string, spanId?: string): void;

  // Batching
  enableBatchLogging(): void;
  disableBatchLogging(): Promise<void>;
  flush(): Promise<void>;
}
```

### Configuration

```typescript
class Configuration {
  // Properties
  debug?: string[];
  severity: SeverityKind;
  transport: Logger;
  batchLogging: boolean;
  maxBatchSize: number;
  autoFlushMs: number;

  // Methods
  getSeverity(name?: string): SeverityKind;
  setDebug(debug: string): void;
  configureBatching(options: { batchLogging?: boolean; maxBatchSize?: number; autoFlushMs?: number }): void;
}
```

### Integration Middleware

```typescript
// Express
function expressLogger(
  logger: Logger,
  options?: ExpressLoggerOptions,
): (req: Request, res: Response, next: NextFunction) => void;

// tRPC
function createTRPCLoggerMiddleware<TRouter extends AnyRouter>(
  logger: Logger,
  options?: {
    logInput?: boolean;
    logResponse?: boolean;
    generateRequestId?: () => string;
    attributes?: Attributes;
  },
): (opts: any) => Promise<unknown>;
```

## License

MIT
