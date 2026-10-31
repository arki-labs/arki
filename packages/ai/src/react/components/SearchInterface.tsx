/**
 * Generic Search Interface Component
 */

'use client';

import React, { useState, useRef, useEffect } from 'react';
import type { SearchResult } from '../hooks/useSemanticSearch.js';

export type SearchInterfaceProps<TMetadata = Record<string, unknown>> = {
  query: string;
  results: SearchResult<TMetadata>[];
  suggestions: string[];
  isSearching: boolean;
  onQueryChange: (query: string) => void;
  onSearch: (query: string) => void;
  onSuggestionSelect?: (suggestion: string) => void;
  placeholder?: string;
  className?: string;
  renderResult?: (result: SearchResult<TMetadata>, index: number) => React.ReactNode;
  renderEmptyState?: () => React.ReactNode;
  renderLoadingState?: () => React.ReactNode;
  showSuggestions?: boolean;
  debounce?: boolean;
}

/**
 * Generic Search Interface Component
 */
export function SearchInterface<TMetadata = Record<string, unknown>>({
  query,
  results,
  suggestions,
  isSearching,
  onQueryChange,
  onSearch,
  onSuggestionSelect,
  placeholder = 'Search...',
  className = '',
  renderResult,
  renderEmptyState,
  renderLoadingState,
  showSuggestions = true,
  debounce = true,
}: SearchInterfaceProps<TMetadata>) {
  const [showSuggestionsDropdown, setShowSuggestionsDropdown] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Handle click outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowSuggestionsDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    onQueryChange(value);
    setShowSuggestionsDropdown(true);
    setSelectedSuggestionIndex(-1);

    if (debounce) {
      // Debounced search is handled by the hook
      onSearch(value);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!debounce) {
      onSearch(query);
    }
    setShowSuggestionsDropdown(false);
  };

  const handleSuggestionClick = (suggestion: string) => {
    onQueryChange(suggestion);
    onSearch(suggestion);
    if (onSuggestionSelect) {
      onSuggestionSelect(suggestion);
    }
    setShowSuggestionsDropdown(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestionsDropdown || suggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      }
      case 'Enter': {
        if (selectedSuggestionIndex >= 0) {
          e.preventDefault();
          handleSuggestionClick(suggestions[selectedSuggestionIndex]!);
        }
        break;
      }
      case 'Escape': {
        setShowSuggestionsDropdown(false);
        setSelectedSuggestionIndex(-1);
        break;
      }
    }
  };

  const defaultRenderResult = (result: SearchResult<TMetadata>, index: number) => (
    <div
      key={result.id || index}
      className="p-4 border-b last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      {'preview' in result && typeof result.preview === 'string' && result.preview ? (
        <p className="text-gray-700 dark:text-gray-300 mb-2">
          {result.preview}
        </p>
      ) : null}
      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-500">
          Score: {(result.score * 100).toFixed(1)}%
        </span>
        {result.metadata && (
          <span className="text-sm text-gray-500">
            {JSON.stringify(result.metadata).slice(0, 50)}...
          </span>
        )}
      </div>
    </div>
  );

  const defaultRenderEmptyState = () => (
    <div className="text-center py-8 text-gray-500">
      {query ? 'No results found' : 'Enter a query to search'}
    </div>
  );

  const defaultRenderLoadingState = () => (
    <div className="text-center py-8">
      <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white"></div>
      <p className="mt-2 text-gray-500">Searching...</p>
    </div>
  );

  return (
    <div className={`search-interface ${className}`}>
      {/* Search Input */}
      <form onSubmit={handleSubmit} className="relative mb-4">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestionsDropdown(true)}
          placeholder={placeholder}
          className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {!debounce && (
          <button
            type="submit"
            className="absolute right-2 top-1/2 transform -translate-y-1/2 px-4 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Search
          </button>
        )}

        {/* Suggestions Dropdown */}
        {showSuggestions && showSuggestionsDropdown && suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-60 overflow-y-auto"
          >
            {suggestions.map((suggestion, index) => (
              <div
                key={index}
                className={`px-4 py-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
                  index === selectedSuggestionIndex
                    ? 'bg-gray-100 dark:bg-gray-700'
                    : ''
                }`}
                onClick={() => handleSuggestionClick(suggestion)}
              >
                {suggestion}
              </div>
            ))}
          </div>
        )}
      </form>

      {/* Search Results */}
      <div className="search-results border rounded-lg">
        {isSearching
          ? renderLoadingState
            ? renderLoadingState()
            : defaultRenderLoadingState()
          : results.length > 0
          ? results.map((result, index) =>
              renderResult
                ? renderResult(result, index)
                : defaultRenderResult(result, index)
            )
          : renderEmptyState
          ? renderEmptyState()
          : defaultRenderEmptyState()}
      </div>
    </div>
  );
}