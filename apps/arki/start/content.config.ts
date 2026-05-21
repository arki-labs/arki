import { defineConfig } from '@content-collections/core';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);

const { changelogs } = await jiti.import<{ changelogs: any }>('@arki/content/collections/changelog');
const { faqs } = await jiti.import<{ faqs: any }>('@arki/content/collections/faq');
const { legals } = await jiti.import<{ legals: any }>('@arki/content/collections/legal');
const { posts } = await jiti.import<{ posts: any }>('@arki/content/collections/post');

export default defineConfig({
  collections: [posts, legals, faqs, changelogs],
});
