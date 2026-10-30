import { useEffect, useState } from 'react';

import type { PostOverview } from '@arki/content';
import { isFailure } from '@arki/failure';
import { useDebouncedValue } from '@arki/ui/hooks/debounce';

import type { SearchFailure } from './search-posts';
import { searchPosts } from './search-posts';

/**
 * Searches posts through the app's `/posts/search?query=` route as the reader types (debounced 300ms).
 * A newer query aborts the request still in flight.
 *
 * States: `isLoading` while a request runs, `failure` when the last search failed (`SearchUnavailable`
 * for a network error or non-ok response, `SearchResponseMalformed` for a body that is not a list of
 * posts; `result` is then empty), and `retry()` to run the same query again.
 */
const useSearch = () => {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const [attempt, setAttempt] = useState(0);
  // The last finished search and the query and attempt it answered. A search is loading while nothing finished for the current ones.
  const [settled, setSettled] = useState<
    { query: string; attempt: number; outcome: PostOverview[] | SearchFailure } | undefined
  >();

  useEffect(() => {
    if (debouncedQuery.length === 0) return;
    const abortController = new AbortController();
    void searchPosts(debouncedQuery, abortController.signal).then(outcome => {
      if (abortController.signal.aborted) return;
      setSettled({ query: debouncedQuery, attempt, outcome });
    });
    return () => {
      abortController.abort();
    };
  }, [debouncedQuery, attempt]);

  // An empty query shows nothing and loads nothing, whatever the last search left behind.
  const current = debouncedQuery.length > 0 && settled?.query === debouncedQuery && settled.attempt === attempt ? settled.outcome : undefined;
  return {
    query,
    result: current === undefined || isFailure(current) ? [] : current,
    search: setQuery,
    isLoading: debouncedQuery.length > 0 && current === undefined,
    failure: isFailure(current) ? current : undefined,
    retry: () => {
      setAttempt(count => count + 1);
    },
  };
};

export default useSearch;
