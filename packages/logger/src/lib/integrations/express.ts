import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import type { Logger } from '../logger';
import type { Attributes } from '../types';

/**
 * Options for the Express logger middleware
 */
export type ExpressLoggerOptions = {
  /**
   * Whether to log request bodies
   * @default false
   */
  logBody?: boolean;

  /**
   * Whether to log request headers
   * @default false
   */
  logHeaders?: boolean;

  /**
   * Additional attributes to include with each log entry
   */
  attributes?: Attributes;

  /**
   * Skip logging for certain requests
   * @param req - Express request object
   * @returns True if logging should be skipped
   */
  skip?: (req: Request) => boolean;

  /**
   * Override the request ID generator
   * @returns A unique ID for the request
   */
  generateRequestId?: () => string;
};

// Define request data interface to properly type the object
type RequestData = {
  method: string;
  url: string;
  ip?: string;
  headers?: unknown;
  body?: unknown;
};

// Define response data interface
type ResponseData = {
  statusCode: number;
  duration: number;
};

/**
 * Creates an Express middleware for request logging
 *
 * @param logger - Logger instance to use
 * @param options - Configuration options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { createLogger, expressLogger } from '@your-org/logger';
 *
 * const app = express();
 * const logger = createLogger('api');
 *
 * app.use(expressLogger(logger));
 *
 * app.listen(3000, () => {
 *   logger.info('Server started on port 3000');
 * });
 * ```
 */
export function expressLogger(logger: Logger, options: ExpressLoggerOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip logging if the skip function returns true
    if (options.skip?.(req)) {
      return next();
    }

    // Generate request ID
    const requestId = options.generateRequestId?.() || randomUUID();
    req.headers['x-request-id'] = requestId;

    // Set trace context in logger
    const requestLogger = logger.withAttribute('requestId', requestId);
    requestLogger.setTraceContext(requestId);

    // Capture timing data
    const startTime = Date.now();

    // Prepare request data
    const requestData: RequestData = {
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip || req.connection.remoteAddress,
    };

    // Add optional request data
    if (options.logHeaders) {
      requestData.headers = req.headers;
    }

    if (options.logBody && req.body) {
      requestData.body = req.body;
    }

    // Add custom attributes
    const attributes: Attributes = { ...options.attributes };
    attributes['request'] = JSON.stringify(requestData);

    // Log request
    requestLogger.info('Request received', attributes);

    // Add response logging
    const originalEnd = res.end;

    // We need to use 'any' here to bypass TypeScript's type checking for the complex overloaded signatures
    res.end = function (this: Response, chunk?: any, encoding?: any, cb?: () => void) {
      // Restore original end
      res.end = originalEnd;

      // Calculate duration
      const duration = Date.now() - startTime;

      // Prepare response data
      const responseData: ResponseData = {
        statusCode: res.statusCode,
        duration,
      };

      // Create attributes for response
      const responseAttributes: Attributes = { ...attributes };
      responseAttributes['response'] = JSON.stringify(responseData);

      // Log response
      if (res.statusCode >= 400) {
        requestLogger.warn('Request completed', responseAttributes);
      } else {
        requestLogger.info('Request completed', responseAttributes);
      }

      // Call original end with all arguments
      switch (arguments.length) {
        case 0: {
          return originalEnd.call(this, null, 'utf8');
        }
        case 1: {
          return originalEnd.call(this, chunk, 'utf8');
        }
        case 2: {
          return originalEnd.call(this, chunk, encoding);
        }
        default: {
          return originalEnd.call(this, chunk, encoding, cb);
        }
      }
    };

    next();
  };
}
