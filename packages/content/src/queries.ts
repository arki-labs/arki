/** What sorting and lookup read from a dated entry. A content-build `Post` or `Changelog` has these fields. */
type DatedEntry = { slug: string; publishedAt: Date };

/** What sorting and lookup read from a legal document. A content-build `Legal` has these fields. */
type TitledEntry = { slug: string; title: string };

/** What sorting reads from a FAQ entry. A content-build `Faq` has this field. */
type OrderedEntry = { order: number };

/**
 * The `content-collections` module, or any part of it. Each `all*` array is optional, so an app passes
 * whatever collections it has. Other exports (an app's own collections) are allowed and ignored.
 */
export type GeneratedCollections = {
  allPosts?: readonly DatedEntry[];
  allChangelogs?: readonly DatedEntry[];
  allLegals?: readonly TitledEntry[];
  allFAQs?: readonly OrderedEntry[];
};

type PostQueries<G> = G extends { allPosts: readonly (infer P)[] }
  ? { posts: P[]; postBySlug: (slug: string) => P | undefined }
  : unknown;

type ChangelogQueries<G> = G extends { allChangelogs: readonly (infer C)[] }
  ? { changelogs: C[]; changelogBySlug: (slug: string) => C | undefined }
  : unknown;

type LegalQueries<G> = G extends { allLegals: readonly (infer L)[] }
  ? { legals: L[]; legalBySlug: (slug: string) => L | undefined }
  : unknown;

type FaqQueries<G> = G extends { allFAQs: readonly (infer F)[] } ? { faqs: F[] } : unknown;

type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * The sorted lists and lookups for the collections in `G`. A collection that `G` lacks has no keys here,
 * so an app without posts cannot import `posts` by mistake.
 */
export type ContentQueries<G extends GeneratedCollections> = Flatten<
  PostQueries<G> & ChangelogQueries<G> & LegalQueries<G> & FaqQueries<G>
>;

type AnyContentQueries = {
  posts?: DatedEntry[];
  postBySlug?: (slug: string) => DatedEntry | undefined;
  changelogs?: DatedEntry[];
  changelogBySlug?: (slug: string) => DatedEntry | undefined;
  legals?: TitledEntry[];
  legalBySlug?: (slug: string) => TitledEntry | undefined;
  faqs?: OrderedEntry[];
};

function newestFirst<T extends DatedEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

function findBySlug<T extends { slug: string }>(entries: readonly T[]): (slug: string) => T | undefined {
  return slug => entries.find(entry => entry.slug === slug);
}

/**
 * Sorts an app's generated content once and builds slug lookups for it.
 *
 * - posts and changelogs: newest `publishedAt` first
 * - legals: by `title` (`localeCompare`)
 * - faqs: by `order`, lowest first
 *
 * The generated arrays are never changed; each list is a sorted copy. Element types come from the generated
 * arrays, so `posts` is a `Post[]` without importing `Post`. Only collections the app has get keys.
 *
 * @example
 * import * as generated from 'content-collections';
 * import { contentQueries } from '@arki/content';
 *
 * export const { posts, changelogs, legals, faqs, changelogBySlug } = contentQueries(generated);
 */
export function contentQueries<G extends GeneratedCollections>(generated: G): ContentQueries<G>;
// The precise return type depends on which keys `G` has. TypeScript cannot check an object built at run
// time against that conditional type, so the body is typed against the loose shape and the signature above
// states the precise one.
export function contentQueries(generated: GeneratedCollections): AnyContentQueries {
  const queries: AnyContentQueries = {};
  if (generated.allPosts) {
    const posts = newestFirst(generated.allPosts);
    queries.posts = posts;
    queries.postBySlug = findBySlug(posts);
  }
  if (generated.allChangelogs) {
    const changelogs = newestFirst(generated.allChangelogs);
    queries.changelogs = changelogs;
    queries.changelogBySlug = findBySlug(changelogs);
  }
  if (generated.allLegals) {
    const legals = [...generated.allLegals].sort((a, b) => a.title.localeCompare(b.title));
    queries.legals = legals;
    queries.legalBySlug = findBySlug(legals);
  }
  if (generated.allFAQs) {
    queries.faqs = [...generated.allFAQs].sort((a, b) => a.order - b.order);
  }
  return queries;
}
