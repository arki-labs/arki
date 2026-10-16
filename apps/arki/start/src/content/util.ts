import { allChangelogs, allFAQs, allLegals, allPosts } from 'content-collections';

export const posts = allPosts.toSorted((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

export const faqs = allFAQs.toSorted((a, b) => a.order - b.order);

export const changelogs = allChangelogs.toSorted((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

export const legals = allLegals.toSorted((a, b) => a.title.localeCompare(b.title));

export const changelogBySlug = (slug: string) => {
  return changelogs.find(changelog => changelog.slug === slug);
};
