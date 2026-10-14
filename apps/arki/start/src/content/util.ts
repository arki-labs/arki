import { allChangelogs, allFAQs, allLegals, allPosts } from 'content-collections';

import type { Changelog, Faq, Legal, Post } from '@arki/content';

export const posts = (allPosts as Post[]).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

export const faqs = (allFAQs as Faq[]).sort((a, b) => a.order - b.order);

export const changelogs = (allChangelogs as Changelog[]).sort(
  (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
);

export const legals = (allLegals as Legal[]).sort((a, b) => a.title.localeCompare(b.title));

export const changelogBySlug = (slug: string) => {
  return changelogs.find(changelog => changelog.slug === slug);
};
