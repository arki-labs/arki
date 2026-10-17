import { squish, truncate } from '../src/format.js';
import { readingTime } from '../src/readability.js';
import { slugify } from '../src/slug.js';

// #region describe-post
/** What a blog index needs from a post: a URL slug, a one-line summary and a reading time. */
export function describePost(title: string, body: string): { slug: string; summary: string; minutes: number } {
  return {
    slug: slugify(title),
    summary: truncate(squish(body), 60, { boundary: 'word-before' }),
    minutes: Math.max(1, Math.round(readingTime(body).minutes)),
  };
}
// #endregion
