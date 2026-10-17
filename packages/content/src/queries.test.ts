import { describe, expect, expectTypeOf, it } from 'vitest';

import type { GeneratedCollections } from './index';
import { contentQueries } from './index';

// Shapes like the ones content-collections generates: more fields than contentQueries reads, plus a literal
// `kind` so the type tests can tell whether the exact element type survived.
type Post = { kind: 'post'; slug: string; title: string; publishedAt: Date; author: { name: string } };
type Changelog = { kind: 'changelog'; slug: string; title: string; publishedAt: Date };
type Legal = { kind: 'legal'; slug: string; title: string };
type Faq = { kind: 'faq'; question: string; order: number };
type Branch = { kind: 'branch'; slug: string };

const post = (slug: string, publishedAt: string): Post => ({
  kind: 'post',
  slug,
  title: slug,
  publishedAt: new Date(publishedAt),
  author: { name: 'Ada' },
});
const changelog = (slug: string, publishedAt: string): Changelog => ({
  kind: 'changelog',
  slug,
  title: slug,
  publishedAt: new Date(publishedAt),
});
const legal = (slug: string, title: string): Legal => ({ kind: 'legal', slug, title });
const faq = (question: string, order: number): Faq => ({ kind: 'faq', question, order });

// Frozen, so any in-place sort throws instead of quietly reordering the generated data.
const allPosts = Object.freeze([post('old', '2025-01-01'), post('new', '2026-03-01'), post('mid', '2025-06-01')]);
const allChangelogs = Object.freeze([
  changelog('v1', '2025-01-01'),
  changelog('v3', '2026-01-01'),
  changelog('v2', '2025-07-01'),
]);
const allLegals = Object.freeze([
  legal('terms', 'Terms of Service'),
  legal('cookies', 'Cookie Policy'),
  legal('privacy', 'Privacy Policy'),
]);
const allFAQs = Object.freeze([faq('third', 3), faq('first', 1), faq('second', 2)]);
const allBranches: Branch[] = [{ kind: 'branch', slug: 'main' }];

const slugs = (entries: readonly { slug: string }[]) => entries.map(entry => entry.slug);

describe('contentQueries sorting', () => {
  const queries = contentQueries({ allPosts, allChangelogs, allLegals, allFAQs });

  it('lists posts newest first, so the blog index leads with the latest post', () => {
    expect(slugs(queries.posts)).toEqual(['new', 'mid', 'old']);
  });

  it('lists changelogs newest first, so the latest release is on top', () => {
    expect(slugs(queries.changelogs)).toEqual(['v3', 'v2', 'v1']);
  });

  it('lists legal documents by title, so the footer reads alphabetically', () => {
    expect(queries.legals.map(doc => doc.title)).toEqual(['Cookie Policy', 'Privacy Policy', 'Terms of Service']);
  });

  it('lists FAQs by their order field, so authors control the sequence', () => {
    expect(queries.faqs.map(entry => entry.order)).toEqual([1, 2, 3]);
  });

  it('never reorders the generated arrays', () => {
    expect(slugs(allPosts)).toEqual(['old', 'new', 'mid']);
    expect(slugs(allChangelogs)).toEqual(['v1', 'v3', 'v2']);
    expect(slugs(allLegals)).toEqual(['terms', 'cookies', 'privacy']);
    expect(allFAQs.map(entry => entry.order)).toEqual([3, 1, 2]);
    expect(queries.posts).not.toBe(allPosts);
  });
});

describe('contentQueries lookups', () => {
  const queries = contentQueries({ allPosts, allChangelogs, allLegals });

  it('finds an entry by slug', () => {
    expect(queries.postBySlug('mid')).toBe(allPosts[2]);
    expect(queries.changelogBySlug('v3')).toBe(allChangelogs[1]);
    expect(queries.legalBySlug('privacy')).toBe(allLegals[2]);
  });

  it('returns undefined for an unknown slug, so routes can answer 404', () => {
    expect(queries.postBySlug('missing')).toBeUndefined();
    expect(queries.changelogBySlug('missing')).toBeUndefined();
    expect(queries.legalBySlug('missing')).toBeUndefined();
  });
});

describe('contentQueries keys', () => {
  it('only builds keys for collections the module has', () => {
    const queries = contentQueries({ allLegals, allBranches });
    expect(new Set(Object.keys(queries))).toEqual(new Set(['legals', 'legalBySlug']));
  });

  it('keeps each element type, so apps never import Post or Legal', () => {
    const queries = contentQueries({ allPosts, allChangelogs, allLegals, allFAQs });
    expectTypeOf(queries.posts).toEqualTypeOf<Post[]>();
    expectTypeOf(queries.postBySlug).returns.toEqualTypeOf<Post | undefined>();
    expectTypeOf(queries.changelogs).toEqualTypeOf<Changelog[]>();
    expectTypeOf(queries.changelogBySlug).returns.toEqualTypeOf<Changelog | undefined>();
    expectTypeOf(queries.legals).toEqualTypeOf<Legal[]>();
    expectTypeOf(queries.legalBySlug).returns.toEqualTypeOf<Legal | undefined>();
    expectTypeOf(queries.faqs).toEqualTypeOf<Faq[]>();
  });

  it('has no keys for missing collections, so importing posts in a legal-only app fails to compile', () => {
    expectTypeOf(contentQueries({ allLegals })).toEqualTypeOf<{
      legals: Legal[];
      legalBySlug: (slug: string) => Legal | undefined;
    }>();

    const noFaqs = contentQueries({ allPosts, allChangelogs, allLegals });
    expectTypeOf(noFaqs).not.toHaveProperty('faqs');

    expectTypeOf(contentQueries({ allChangelogs, allFAQs, allLegals, allBranches })).toEqualTypeOf<{
      changelogs: Changelog[];
      changelogBySlug: (slug: string) => Changelog | undefined;
      legals: Legal[];
      legalBySlug: (slug: string) => Legal | undefined;
      faqs: Faq[];
    }>();
  });

  it('rejects a collection without the fields it sorts by', () => {
    const undated = [{ slug: 'a', title: 'A' }];
    expectTypeOf({ allPosts: undated }).not.toExtend<GeneratedCollections>();
    expectTypeOf({ allPosts }).toExtend<GeneratedCollections>();
  });
});
