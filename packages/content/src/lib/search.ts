import type { Options, SearchResult } from 'minisearch';
import MiniSearch from 'minisearch';

import type { Post, PostOverview } from '../models';

const createSearchOptions = <T extends (keyof Post)[]>(
  idField: keyof Post,
  fields: T,
  storeFields: (keyof PostOverview)[],
  boost: Record<T[number], number>,
): Options<PostOverview> => ({
  idField,
  fields,
  storeFields,
  searchOptions: {
    boost,
  },
});

/** How posts are indexed: which fields are searched, which are returned, and how much each field counts. */
export const postSearchOptions = createSearchOptions(
  'url',
  ['title', 'description', 'content', 'tags'],
  ['url', 'title', 'description', 'publishedAt', 'readingTime', 'image'],
  {
    title: 1.6,
    description: 1.2,
    content: 1,
    tags: 1.8,
  },
);

/** Build a search index over posts. Matching uses the raw post body, not the compiled MDX. */
export function createPostSearchIndex(posts: Post[]): MiniSearch<PostOverview> {
  const index = new MiniSearch(postSearchOptions);
  index.addAll(posts.map(post => ({ ...post, content: post.content.raw })));
  return index;
}

/** Restore an index written by `JSON.stringify(index)` (for example the build's `search-index.json`). */
export function loadPostSearchIndex(json: string): MiniSearch<PostOverview> {
  return MiniSearch.loadJSON(json, postSearchOptions);
}

export type PostSearchResult = SearchResult & Partial<PostOverview>;

/** Search an index. Best match first. */
export function searchPosts(index: MiniSearch<PostOverview>, query: string): PostSearchResult[] {
  return index.search(query);
}
