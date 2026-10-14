import { defineConfig } from '@content-collections/core';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);

const { changelogs } = await jiti.import<{ changelogs: any }>('@arki/content/node');
const { faqs } = await jiti.import<{ faqs: any }>('@arki/content/node');
const { legals } = await jiti.import<{ legals: any }>('@arki/content/node');
const { posts } = await jiti.import<{ posts: any }>('@arki/content/node');

export default defineConfig({
  collections: [posts, legals, faqs, changelogs],
});
