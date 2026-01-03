/**
 * TanStack Start Server Configuration
 *
 * Provides server setup utilities for running TanStack Start with Bun.
 */

import type { Server } from 'bun';

export interface ServerConfig {
  /**
   * Server port
   * @default 3000
   */
  port?: number;

  /**
   * Server hostname
   * @default '0.0.0.0'
   */
  hostname?: string;

  /**
   * Enable development mode
   * @default process.env.NODE_ENV !== 'production'
   */
  development?: boolean;

  /**
   * Custom fetch handler to run before the app handler
   */
  beforeFetch?: (request: Request) => Response | null | Promise<Response | null>;

  /**
   * Custom fetch handler to run after the app handler if it returns null
   */
  afterFetch?: (request: Request) => Response | null | Promise<Response | null>;

  /**
   * Static file serving configuration
   */
  static?: {
    /**
     * Directory to serve static files from
     * @default './dist/client'
     */
    directory?: string;

    /**
     * URL prefix for static files
     * @default '/assets'
     */
    prefix?: string;
  };
}

/**
 * Creates a Bun server handler for TanStack Start
 *
 * @example
 * ```ts
 * // server.ts
 * import { createServerHandler } from '@arki/tanstack-start/server';
 * import { createRouter } from './router';
 *
 * const handler = await import('./dist/server/entry-server.js');
 *
 * createServerHandler({
 *   port: 3000,
 *   development: process.env.NODE_ENV !== 'production',
 * }, handler.default);
 * ```
 */
export function createServerHandler(
  config: ServerConfig,
  appHandler: (request: Request) => Response | Promise<Response>,
): Server {
  const {
    port = Number(process.env.PORT) || 3000,
    hostname = '0.0.0.0',
    development = process.env.NODE_ENV !== 'production',
    beforeFetch,
    afterFetch,
    static: staticConfig,
  } = config;

  const staticDirectory = staticConfig?.directory ?? './dist/client';
  const staticPrefix = staticConfig?.prefix ?? '/assets';

  return Bun.serve({
    port,
    hostname,
    development,

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Run before fetch hook
      if (beforeFetch) {
        const response = await beforeFetch(request);
        if (response) return response;
      }

      // Serve static files
      if (url.pathname.startsWith(staticPrefix)) {
        const filePath = `${staticDirectory}${url.pathname}`;
        const file = Bun.file(filePath);

        if (await file.exists()) {
          return new Response(file, {
            headers: {
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        }
      }

      // Try app handler
      try {
        const response = await appHandler(request);
        if (response) return response;
      } catch (error) {
        console.error('Server error:', error);

        if (development) {
          return new Response(`Server Error: ${error instanceof Error ? error.message : 'Unknown error'}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        return new Response('Internal Server Error', { status: 500 });
      }

      // Run after fetch hook
      if (afterFetch) {
        const response = await afterFetch(request);
        if (response) return response;
      }

      return new Response('Not Found', { status: 404 });
    },
  });
}

/**
 * Graceful shutdown handler for Bun server
 */
export function setupGracefulShutdown(server: Server, cleanup?: () => Promise<void>): void {
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Close the server
    server.stop();

    // Run cleanup
    if (cleanup) {
      await cleanup();
    }

    console.log('Server shut down successfully');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
