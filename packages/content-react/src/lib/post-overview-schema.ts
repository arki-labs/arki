/**
 * The Zod schema of one post overview on the search wire. It lives apart from `search-posts.ts` so the
 * package's public `.d.ts` names no Zod type (`TYPES_E001`); `search-posts.test.ts` locks it to `PostOverview`.
 */
import { z } from 'zod';

/** What the route sends for one post. Dates travel as ISO text and come back as `Date`. */
export const postOverviewSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  publishedAt: z.coerce.date(),
  readingTime: z.string(),
  image: z.object({ url: z.string(), blurDataURL: z.string().optional() }),
});
