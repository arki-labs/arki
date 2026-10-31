'use client';

/**
 * React hook for semantic search
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import type { RuntimeFailure } from '../../runtime/types.js';
import type { SearchMode } from '../../types.js';
import { jsonTextSchema, readFailureResponse } from '../../runtime/sse.js';
import { connectionFailure } from '../../runtime/types.js';

export type SearchResult<TMetadata = Record<string, unknown>> = {
  id: string;
  score: number;
  data?: Record<string, unknown>;
  highlights?: string[];
  metadata?: TMetadata;
}

/** A {@link SearchResult} as the search endpoint sends it. A two-way type test locks it to the type. */
export const searchResultSchema = z.object({
  id: z.string(),
  score: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
  highlights: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** The search endpoint answers `{ results: SearchResult[] }` or a bare `SearchResult[]`. */
const searchResponseSchema = jsonTextSchema.pipe(
  z.union([z.object({ results: z.array(searchResultSchema) }).transform(body => body.results), z.array(searchResultSchema)]),
);

const suggestionsResponseSchema = jsonTextSchema.pipe(z.object({ suggestions: z.array(z.string()) }));

export type SearchFilters = Record<string, string | number | boolean | string[] | number[]>

export type UseSemanticSearchOptions = {
  apiEndpoint?: string;
  mode?: SearchMode;
  limit?: number;
  debounceMs?: number;
  minQueryLength?: number;
  onSearch?: (query: string) => void;
  onResults?: (results: SearchResult[]) => void;
  /**
   * Hears why a search failed: the failure the server answered with (its `{ error: envelope }` body,
   * revived), `InvalidInput` for a body that is not a list of results, or `ConnectionLost`.
   */
  onError?: (failure: RuntimeFailure) => void;
}

export type UseSemanticSearchReturn<TMetadata = Record<string, unknown>> = {
  query: string;
  results: SearchResult<TMetadata>[];
  isSearching: boolean;
  error: RuntimeFailure | null;
  search: (query: string, filters?: SearchFilters) => Promise<void>;
  setQuery: (query: string) => void;
  clearResults: () => void;
  suggestions: string[];
  getSuggestions: (prefix: string) => Promise<void>;
}

/** One search request: the results, or the failure the server, the body or the connection gave. */
async function requestSearch(
  apiEndpoint: string,
  body: { query: string; mode: SearchMode; limit: number; filters: SearchFilters | undefined },
  signal: AbortSignal,
): Promise<SearchResult[] | RuntimeFailure> {
  let response: Response;
  try {
    response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return connectionFailure(error, signal);
  }
  if (!response.ok) return readFailureResponse(response);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return connectionFailure(error, signal);
  }
  return parse(searchResponseSchema, text);
}

/**
 * Hook for semantic search functionality. Results are checked by {@link searchResultSchema}, so their
 * `metadata` is a plain record: check it with your own schema to type it.
 */
export function useSemanticSearch(options: UseSemanticSearchOptions = {}): UseSemanticSearchReturn {
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
  const [results, setResults] = useState<SearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<RuntimeFailure | null>(null);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Perform search
   */
  const performSearch = useCallback(
    async (searchQuery: string, filters?: SearchFilters) => {
      // Cancel any previous request
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;

      // Check minimum query length
      if (searchQuery.length < minQueryLength) {
        setResults([]);
        setIsSearching(false);
        return;
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsSearching(true);
      setError(null);

      if (onSearch) onSearch(searchQuery);

      const outcome = await requestSearch(apiEndpoint, { query: searchQuery, mode, limit, filters }, controller.signal);
      // A newer search, or unmount, replaced this one: its outcome and its `isSearching` are not ours to set.
      if (abortControllerRef.current !== controller) return;
      abortControllerRef.current = null;
      setIsSearching(false);

      if (isFailure(outcome)) {
        setError(outcome);
        if (onError) onError(outcome);
        return;
      }
      setResults(outcome);
      if (onResults) onResults(outcome);
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
        void performSearch(searchQuery, filters);
      }, debounceMs);
    },
    [performSearch, debounceMs]
  );

  /**
   * Get search suggestions
   */
  const getSuggestions = useCallback(
    async (prefix: string) => {
      if (prefix.length === 0) {
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

        const data = response.ok ? parse(suggestionsResponseSchema, await response.text()) : undefined;
        // Suggestions are not critical: a failed or malformed answer shows none.
        setSuggestions(data === undefined || isFailure(data) ? [] : data.suggestions);
      } catch {
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
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
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