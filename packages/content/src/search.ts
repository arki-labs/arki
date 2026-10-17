import type { Options, SearchResult } from 'minisearch';
import MiniSearch from 'minisearch';

/** The fields a search result carries back. The index stores them, so a result needs no second lookup. */
export type PostOverview = {
  url: string;
  title: string;
  description: string;
  publishedAt: Date;
  readingTime: string;
  image: { url: string; blurDataURL?: string };
};

/** What the index reads from a post: its overview, plus the searched tags and raw body. A content-build `Post` fits. */
export type SearchablePost = PostOverview & {
  tags: readonly string[];
  content: { raw: string };
};

/** A post as the index holds it: the raw body is the searched `content`. */
type IndexedPost = Omit<SearchablePost, 'content'> & { content: string };

const storeFields: (keyof PostOverview)[] = ['url', 'title', 'description', 'publishedAt', 'readingTime', 'image'];

/** How posts are indexed: which fields are searched, which are returned, and how much each field counts. */
export const postSearchOptions: Options<IndexedPost> = {
  idField: 'url',
  fields: ['title', 'description', 'content', 'tags'] satisfies (keyof IndexedPost)[],
  storeFields,
  searchOptions: {
    boost: { title: 1.6, description: 1.2, content: 1, tags: 1.8 },
  },
};

/** Build a search index over posts. Matching uses the raw post body, not the compiled MDX. */
export function createPostSearchIndex(posts: readonly SearchablePost[]): MiniSearch<IndexedPost> {
  const index = new MiniSearch(postSearchOptions);
  index.addAll(posts.map(post => ({ ...post, content: post.content.raw })));
  return index;
}

/** Restore an index written by `JSON.stringify(index)` (for example the build's `search-index.json`). */
export function loadPostSearchIndex(json: string): MiniSearch<IndexedPost> {
  return MiniSearch.loadJSON(json, postSearchOptions);
}

export type PostSearchResult = SearchResult & Partial<PostOverview>;

/** Search an index. Best match first. */
export function searchPosts(index: MiniSearch<IndexedPost>, query: string): PostSearchResult[] {
  return index.search(query);
}
