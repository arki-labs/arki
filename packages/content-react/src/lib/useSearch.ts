import { useEffect, useState } from 'react';

import type { PostOverview } from '@arki/content';
import { useDebouncedValue } from '@arki/ui/hooks/debounce';

/**
 * Searches posts through the app's `/posts/search?query=` route as the reader types (debounced 300ms).
 * A newer query aborts the request still in flight.
 *
 * States: `isLoading` while a request runs, `isError` when the last search failed (network error,
 * non-ok response, or a body that is not JSON; `result` is then empty), and `retry()` to run the same
 * query again.
 */
const useSearch = () => {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<PostOverview[]>([]);
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (debouncedQuery.length === 0) return;
    const abortController = new AbortController();
    const search = async () => {
      setIsLoading(true);
      setIsError(false);
      const response = await fetch(`/posts/search?query=${encodeURIComponent(debouncedQuery)}`, {
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error('failed to search');
      }
      setResult(await response.json());
      setIsLoading(false);
    };
    search().catch(() => {
      if (abortController.signal.aborted) return;
      setResult([]);
      setIsError(true);
      setIsLoading(false);
    });
    return () => {
      abortController.abort();
    };
  }, [debouncedQuery, attempt]);

  // An empty query shows nothing and loads nothing, whatever the last search left behind.
  const hasQuery = debouncedQuery.length > 0;
  return {
    query,
    result: hasQuery ? result : [],
    search: setQuery,
    isLoading: hasQuery && isLoading,
    isError: hasQuery && isError,
    retry: () => {
      setAttempt((count) => count + 1);
    },
  };
};

export default useSearch;
