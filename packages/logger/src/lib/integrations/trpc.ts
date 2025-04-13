import type { AnyRouter } from '@trpc/server';
import { TRPCError } from '@trpc/server';

import type { Logger } from '../logger';
import type { Attributes } from '../types';

/**
 * Creates a tRPC middleware for request logging
 *
 * @param logger - Logger instance to use
 * @param options - Optional configuration
 * @returns tRPC middleware function
 *
 * @example
 * ```typescript
 * import { initTRPC } from '@trpc/server';
 * import { createLogger, createTRPCLoggerMiddleware } from '@your-org/logger';
 *
 * const logger = createLogger('trpc-api');
 *
 * const t = initTRPC.create();
 *
 * const loggerMiddleware = createTRPCLoggerMiddleware(logger);
 *
 * export const middleware = t.middleware;
 * export const publicProcedure = t.procedure.use(loggerMiddleware);
 * ```
 */
export function createTRPCLoggerMiddleware<TRouter extends AnyRouter>(
  logger: Logger,
  options: {
    /**
     * Whether to log request input
     * @default true
     */
    logInput?: boolean;

    /**
     * Whether to log response data (can be large)
     * @default false
     */
    logResponse?: boolean;

    /**
     * Function to generate a request ID
     * @default crypto.randomUUID
     */
    generateRequestId?: () => string;

    /**
     * Custom attributes to include with log entries
     */
    attributes?: Attributes;
  } = {},
) {
  // Set defaults
  const {
    logInput = true,
    logResponse = false,
    generateRequestId = () => crypto.randomUUID(),
    attributes = {},
  } = options;

  // Create the middleware function
  // We use 'any' types here because tRPC's middleware types are complex and version-dependent
  const middlewareFn = async (opts: any) => {
    const { path, type, next, ctx, input } = opts;

    // Generate a unique request ID for tracing
    const requestId = generateRequestId();

    // Create a logger instance for this request
    const requestLogger = logger.withAttribute('requestId', requestId);
    requestLogger.setTraceContext(requestId);

    // Add additional context
    const requestLogger2 = requestLogger.withAttribute('path', path).withAttribute('type', type);

    // Prepare request data
    const requestData: Record<string, unknown> = {
      path,
      type,
      timestamp: Date.now(),
    };

    // Include input if enabled
    if (logInput && input !== undefined) {
      requestData['input'] = input;
    }

    // Log request
    const requestAttrs = { ...attributes } as Attributes;
    requestAttrs['request'] = JSON.stringify(requestData);
    requestLogger2.info('tRPC request', requestAttrs);

    // Start timing
    const startTime = Date.now();

    try {
      // Process the request
      const result = await next({
        ctx: {
          ...ctx,
          // Add logger to context for procedure handlers to use
          logger: requestLogger2,
        },
      });

      // Calculate duration
      const duration = Date.now() - startTime;

      // Prepare response data
      const responseData: Record<string, unknown> = {
        path,
        type,
        success: true,
        duration,
      };

      // Include response data if enabled
      if (logResponse && result.data !== undefined) {
        responseData['data'] = result.data;
      }

      // Log successful response
      const responseAttrs = { ...attributes } as Attributes;
      responseAttrs['response'] = JSON.stringify(responseData);
      requestLogger2.info('tRPC response', responseAttrs);

      return result;
    } catch (error) {
      // Calculate duration
      const duration = Date.now() - startTime;

      // Prepare error data
      const errorData: Record<string, unknown> = {
        path,
        type,
        success: false,
        duration,
      };

      // Handle TRPCError specifically
      if (error instanceof TRPCError) {
        errorData['code'] = error.code;
        errorData['message'] = error.message;
      } else if (error instanceof Error) {
        errorData['message'] = error.message;
      } else {
        errorData['message'] = String(error);
      }

      // Log error response
      const errorAttrs = { ...attributes } as Attributes;
      errorAttrs['error'] = JSON.stringify(errorData);
      requestLogger2.error('tRPC error', errorAttrs);

      // Re-throw the error
      throw error;
    }
  };

  return middlewareFn;
}
