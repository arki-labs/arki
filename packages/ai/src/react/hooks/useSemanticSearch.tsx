/**
 * React hook for semantic search
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { SearchMode, SearchResult as BaseSearchResult } from '../../types';

export interface SearchResult<TMetadata = Record<string, unknown>> extends BaseSearchResult {
  metadata?: TMetadata;
}

export interface SearchFilters {
  [key: string]: unknown;
}

export interface UseSemanticSearchOptions {
  apiEndpoint?: string;
  mode?: SearchMode;
  limit?: number;
  debounceMs?: number;
  minQueryLength?: number;
  onSearch?: (query: string) => void;
  onResults?: (results: SearchResult[]) => void;
  onError?: (error: Error) => void;
}

export interface UseSemanticSearchReturn<TMetadata = Record<string, unknown>> {
  query: string;
  results: SearchResult<TMetadata>[];
  isSearching: boolean;
  error: Error | null;
  search: (query: string, filters?: SearchFilters) => Promise<void>;
  setQuery: (query: string) => void;
  clearResults: () => void;
  suggestions: string[];
  getSuggestions: (prefix: string) => Promise<void>;
}

/**
 * Hook for semantic search functionality
 */
export function useSemanticSearch<TMetadata = Record<string, unknown>>(
  options: UseSemanticSearchOptions = {}
): UseSemanticSearchReturn<TMetadata> {
  const {
    apiEndpoint = '/api/search',
    mode = 'semantic',
    limit = 20,
    debounceMs = 300,
    minQueryLength = 2,
    onSearch,
    onResults,
    onError,
  } = options;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult<TMetadata>[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Perform search
   */
  const performSearch = useCallback(
    async (searchQuery: string, filters?: SearchFilters) => {
      // Cancel any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Check minimum query length
      if (searchQuery.length < minQueryLength) {
        setResults([]);
        return;
      }

      setIsSearching(true);
      setError(null);

      if (onSearch) onSearch(searchQuery);

      try {
        abortControllerRef.current = new AbortController();

        const response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: searchQuery,
            mode,
            limit,
            filters,
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`Search failed: ${response.statusText}`);
        }

        const data = await response.json();
        const searchResults = data.results || data;

        setResults(searchResults);
        if (onResults) onResults(searchResults);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setError(err);
          if (onError) onError(err);
        }
      } finally {
        setIsSearching(false);
        abortControllerRef.current = null;
      }
    },
    [apiEndpoint, mode, limit, minQueryLength, onSearch, onResults, onError]
  );

  /**
   * Debounced search
   */
  const search = useCallback(
    async (searchQuery: string, filters?: SearchFilters) => {
      setQuery(searchQuery);

      // Clear previous debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new debounce timer
      debounceTimerRef.current = setTimeout(() => {
        performSearch(searchQuery, filters);
      }, debounceMs);
    },
    [performSearch, debounceMs]
  );

  /**
   * Get search suggestions
   */
  const getSuggestions = useCallback(
    async (prefix: string) => {
      if (prefix.length < 1) {
        setSuggestions([]);
        return;
      }

      try {
        const response = await fetch(`${apiEndpoint}/suggestions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prefix,
            limit: 10,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          setSuggestions(data.suggestions || []);
        }
      } catch (err) {
        // Silently fail for suggestions - they're not critical
        setSuggestions([]);
      }
    },
    [apiEndpoint]
  );

  /**
   * Clear results
   */
  const clearResults = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    query,
    results,
    isSearching,
    error,
    search,
    setQuery,
    clearResults,
    suggestions,
    getSuggestions,
  };
}