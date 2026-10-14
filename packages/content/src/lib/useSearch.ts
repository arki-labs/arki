import { useEffect, useState } from 'react';

import { useDebouncedValue } from '@arki/react-hooks/debounce';

import type { PostOverview } from '../models';

const useSearch = () => {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<PostOverview[]>([]);
  const debouncedQuery = useDebouncedValue(query, 300);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let abortController: AbortController | null = null;
    const search = async () => {
      setIsLoading(true);
      abortController = new AbortController();
      const result = await fetch(`/posts/search?query=${debouncedQuery}`, {
        signal: abortController.signal,
      });
      if (!result.ok) {
        throw new Error('failed to search');
      }
      const json = await result.json();
      setResult(json);
      setIsLoading(false);
    };
    if (debouncedQuery.length > 0) {
      search();
    } else {
      setResult([]);
    }
    return () => {
      if (abortController) {
        abortController.abort();
      }
    };
  }, [debouncedQuery]);

  return {
    query,
    result,
    search: setQuery,
    isLoading,
  };
};

export default useSearch;
