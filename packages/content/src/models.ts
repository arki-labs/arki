import type { GetTypeByName } from '@content-collections/core';

import type { changelogs } from './collections/changelog';
import type { faqs } from './collections/faq';
import type { legals } from './collections/legal';
import type { posts } from './collections/post';

// Each document type is inferred from its collection's schema + transform, so it can never drift
// from what the build actually generates.
export type Post = GetTypeByName<{ content: [typeof posts] }, 'posts'>;

export type Changelog = GetTypeByName<{ content: [typeof changelogs] }, 'Changelogs'>;

export type Faq = GetTypeByName<{ content: [typeof faqs] }, 'FAQs'>;

export type Legal = GetTypeByName<{ content: [typeof legals] }, 'Legals'>;

/** The fields search results show for a post. */
export type PostOverview = Pick<Post, 'url' | 'title' | 'description' | 'publishedAt' | 'readingTime' | 'image'>;
