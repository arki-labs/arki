import { useQueueStatus } from '../mutations/hooks.js';

/**
 * Convenience hook returning the number of mutations currently in the queue.
 *
 * Useful when only the depth matters (e.g. badge counts, progress indicators)
 * and the full status shape from `useQueueStatus` is unnecessary.
 */
export function useQueueDepth(): number {
  return useQueueStatus().queued;
}
