/**
 * Collections barrel.
 *
 * Each per-feature collection lives in its own file (e.g. `posts.ts`,
 * `users.ts`) and exports a collection instance built with
 * `createCollection(...)`. Re-export them from here so consumers can
 * `import { postsCollection } from '~/lib/db'`.
 *
 * Three collection backends are common in this workspace:
 *
 *   queryCollectionOptions    — server is source of truth, browser caches
 *                               with optimistic mutations (most apps)
 *   localStorageCollectionOptions — browser-only, cross-tab sync
 *                               (UI state, ephemeral prefs)
 *   localOnlyCollectionOptions    — in-memory, no persistence
 *                               (per-session scratch)
 *
 * See `apps/games-platform/start/src/lib/db/collections/games.ts` for a
 * worked example of the localStorage pattern.
 */

export {};
