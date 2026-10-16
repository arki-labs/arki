import { defineConfig } from '@content-collections/core';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);

const { changelogs, faqs, legals, posts } =
  await jiti.import<typeof import('@arki/content/node')>('@arki/content/node');

export default defineConfig({
  content: [posts, legals, faqs, changelogs],
});
