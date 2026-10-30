import { z } from 'zod';

import type { PostOverview } from '@arki/content';
import { defineFailure, isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

/** The search request did not complete: the network failed, or the route answered with a non-ok status. The cause holds the error or the status. */
export const SearchUnavailable = /* @__PURE__ */ defineFailure('content_react.search_unavailable', {
  status: 502,
  message: 'The post search request failed.',
  remediation: 'Retry the search. If it keeps failing, check the `/posts/search` route.',
});

/** The route answered, but the body is not JSON or not a list of post overviews. The cause holds the parse failure. */
export const SearchResponseMalformed = /* @__PURE__ */ defineFailure('content_react.search_response_malformed', {
  status: 502,
  message: 'The post search answered with a body that is not a list of posts.',
  remediation: 'Make the `/posts/search` route return a JSON array of post overviews.',
});

/** What the route sends for one post. Dates travel as ISO text and come back as `Date`. */
export const postOverviewSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  publishedAt: z.coerce.date(),
  readingTime: z.string(),
  image: z.object({ url: z.string(), blurDataURL: z.string().optional() }),
});

const postOverviewsSchema = z.array(postOverviewSchema);

/**
 * Asks the app's `/posts/search?query=` route for posts. Returns the posts, or a typed failure:
 * `SearchUnavailable` (network or non-ok) or `SearchResponseMalformed` (not JSON, or the wrong shape).
 * An aborted request returns `SearchUnavailable` too; the caller that aborted ignores it.
 */
export type SearchFailure = ReturnType<typeof SearchUnavailable> | ReturnType<typeof SearchResponseMalformed>;

export async function searchPosts(
  query: string,
  signal: AbortSignal,
  fetchPosts: typeof fetch = fetch,
): Promise<PostOverview[] | SearchFailure> {
  let response: Response;
  try {
    response = await fetchPosts(`/posts/search?query=${encodeURIComponent(query)}`, { signal });
  } catch (error) {
    return SearchUnavailable({ cause: error });
  }
  if (!response.ok) return SearchUnavailable({ cause: response.status });
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return SearchResponseMalformed({ cause: error });
  }
  const posts = parse(postOverviewsSchema, body);
  if (isFailure(posts)) return SearchResponseMalformed({ cause: posts });
  return posts;
}
