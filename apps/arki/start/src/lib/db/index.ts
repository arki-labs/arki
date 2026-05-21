/**
 * TanStack DB — reactive client-side store for offline-first UX.
 *
 * Collections live in ./collections, React hooks in ./hooks, schemas in
 * ./schema. The DBProvider component below ensures collections are
 * initialised on mount; wrap it inside `Providers` (innermost slot, inside
 * QueryClientProvider since QueryCollections depend on TanStack Query).
 */

export { DBProvider } from './provider';
export * from './collections';
export * from './hooks';
export * from './schema';
