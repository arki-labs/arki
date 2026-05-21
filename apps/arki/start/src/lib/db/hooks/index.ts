/**
 * Hooks barrel.
 *
 * Per-feature hooks (`usePosts`, `useUserProfile`, etc.) live in their
 * own files and wrap `useLiveQuery(collection)` with feature-specific
 * filtering, sorting, and mutation helpers.
 *
 * Pattern (mirrors `apps/games-platform/start/src/lib/db/hooks/useGameHistory.ts`):
 *
 *   import { useLiveQuery } from '@tanstack/react-db';
 *   import { postsCollection } from '../collections';
 *
 *   export function usePosts() {
 *     const { data: posts = [], isLoading } = useLiveQuery(postsCollection);
 *     // ...derived state, memoised filters, mutation callbacks
 *     return { posts, isLoading, addPost, updatePost, deletePost };
 *   }
 */

export {};
