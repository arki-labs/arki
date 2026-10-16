import { changelogs } from './collections/changelog.js';
import { faqs } from './collections/faq.js';
import { legals } from './collections/legal.js';
import { posts } from './collections/post.js';
import { defineContentConfig } from './config.js';

export { changelogs } from './collections/changelog.js';
export { faqs } from './collections/faq.js';
export { legals } from './collections/legal.js';
export { posts } from './collections/post.js';

/** A marketing site's content: blog posts, legal pages, FAQs and changelog entries. */
export const marketing = defineContentConfig({ content: [posts, legals, faqs, changelogs] });
