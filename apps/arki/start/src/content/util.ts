import { allChangelogs, allFAQs, allLegals, allPosts } from 'content-collections';

import type { Changelog } from '@arki/content/collections/changelog';
import type { Faq } from '@arki/content/collections/faq';
import type { Legal } from '@arki/content/collections/legal';
import type { Post } from '@arki/content/collections/post';

export const posts = (allPosts as Post[]).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

export const faqs = (allFAQs as Faq[]).sort((a, b) => a.order - b.order);

export const changelogs = (allChangelogs as Changelog[]).sort(
  (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
);

export const legals = (allLegals as Legal[]).sort((a, b) => a.title.localeCompare(b.title));

export const changelogBySlug = (slug: string) => {
  return changelogs.find(changelog => changelog.slug === slug);
};
