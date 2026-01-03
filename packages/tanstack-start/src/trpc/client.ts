/**
 * tRPC Client Setup for TanStack Start
 *
 * Provides client-side tRPC configuration with TanStack Query integration.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { CreateTRPCClientOptions } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import SuperJSON from 'superjson';

export interface TRPCClientConfig {
  /**
   * Base URL for the tRPC API
   * @default '/api/trpc'
   */
  url?: string;

  /**
   * Custom headers to include in requests
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;

  /**
   * Enable batching of requests
   * @default true
   */
  batching?: boolean;

  /**
   * Custom fetch implementation
   */
  fetch?: typeof fetch;
}

/**
 * Creates a tRPC React context and hooks for use with TanStack Query
 *
 * @example
 * ```tsx
 * // trpc/react.tsx
 * import { createTRPCReact } from '@arki/tanstack-start/trpc/client';
 * import type { AppRouter } from '@app/backend/api';
 *
 * export const { TRPCProvider, useTRPC } = createTRPCReact<AppRouter>({
 *   url: '/api/trpc',
 * });
 * ```
 */
export function createTRPCReact<TRouter extends AnyTRPCRouter>(config: TRPCClientConfig = {}) {
  const { url = '/api/trpc', headers, batching = true, fetch: customFetch } = config;

  // Create tRPC context with React Query integration
  const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<TRouter>();

  /**
   * Creates a tRPC client instance
   */
  function createClient(queryClient: QueryClient) {
    const clientOptions: CreateTRPCClientOptions<TRouter> = {
      links: [
        httpBatchLink({
          url,
          transformer: SuperJSON,
          headers: headers ?? (() => ({})),
          fetch: customFetch ?? fetch,
          ...(batching ? {} : { maxURLLength: 0 }), // Disable batching if needed
        }),
      ],
    };

    return createTRPCClient<TRouter>(clientOptions);
  }

  return {
    TRPCProvider,
    useTRPC,
    useTRPCClient,
    createClient,
  };
}

/**
 * Gets the base URL for tRPC based on environment
 */
export function getTRPCUrl(): string {
  // Browser: use relative URL
  if (typeof window !== 'undefined') {
    return '/api/trpc';
  }

  // SSR: use environment variable or localhost
  const url = process.env.VITE_TRPC_URL ?? process.env.TRPC_URL;
  if (url) return url;

  // Default to localhost for development
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}/api/trpc`;
}

export { createTRPCClient, httpBatchLink, SuperJSON };
