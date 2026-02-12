/**
 * oRPC Client Setup for TanStack Start
 *
 * Provides client-side oRPC configuration with TanStack Query integration.
 * Unlike tRPC, oRPC doesn't need its own React context — it works directly
 * with TanStack Query's QueryClient via generated query/mutation options.
 */

import type { RouterClient, AnyRouter } from '@orpc/server';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';

export interface ORPCClientConfig {
  /**
   * Base URL for the oRPC API endpoint
   * @default '/api/orpc'
   */
  url?: string;

  /**
   * Custom headers to include in requests.
   * Called before each request, allowing dynamic headers (e.g., auth tokens).
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * Creates an oRPC client with TanStack Query integration.
 *
 * Returns a raw `client` for direct procedure calls and `orpc` utils
 * for generating TanStack Query options (queryOptions, mutationOptions, etc.).
 *
 * @example
 * ```tsx
 * // lib/orpc.ts
 * import { createORPCReact, getORPCUrl } from '@arki/tanstack-start/orpc/client';
 * import type { AppRouter } from '@my-app/backend';
 *
 * export const { client, orpc } = createORPCReact<AppRouter>({
 *   url: getORPCUrl(),
 * });
 *
 * // In components — use with TanStack Query hooks:
 * import { useQuery, useMutation } from '@tanstack/react-query';
 * import { orpc } from '~/lib/orpc';
 *
 * const { data } = useQuery(orpc.documents.list.queryOptions({ input: {} }));
 * const mutation = useMutation(orpc.documents.create.mutationOptions());
 * ```
 */
export function createORPCReact<TRouter extends AnyRouter>(config: ORPCClientConfig = {}) {
  const { url = '/api/orpc', headers } = config;

  const link = new RPCLink({
    url,
    headers: headers ?? (async () => ({})),
  });

  const client = createORPCClient<RouterClient<TRouter>>(link);
  const orpc = createTanstackQueryUtils(client);

  return { client, orpc };
}

/**
 * Gets the base URL for oRPC based on environment.
 *
 * - Browser: returns relative URL `/api/orpc`
 * - SSR: uses `VITE_ORPC_URL` or `ORPC_URL` env var, falling back to localhost
 */
export function getORPCUrl(): string {
  // Browser: use relative URL
  if (typeof window !== 'undefined') {
    return '/api/orpc';
  }

  // SSR: use environment variable or localhost
  const url = process.env.VITE_ORPC_URL ?? process.env.ORPC_URL;
  if (url) return url;

  // Default to localhost for development
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}/api/orpc`;
}

export { createORPCClient, RPCLink, createTanstackQueryUtils };
export type { RouterClient };
