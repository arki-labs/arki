/**
 * DBProvider — initialises TanStack DB collections on mount.
 *
 * TanStack DB collections are singletons created at module-eval time, so
 * importing them is what "starts" them. This provider exists so the wiring
 * is explicit in the provider tree (and so future per-app setup — e.g.
 * preloading, cross-tab sync wiring, mutation persistence — has a home).
 *
 * Place it inside ORPCReactProvider in root-provider.tsx so QueryCollections
 * have access to the QueryClient.
 */

import type { ReactNode } from 'react';

import './collections';

type DBProviderProps = {
  children: ReactNode;
};

export function DBProvider({ children }: DBProviderProps) {
  return <>{children}</>;
}
