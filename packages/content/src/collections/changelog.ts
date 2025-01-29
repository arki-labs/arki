import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import readingTime from 'reading-time';
import { addIdToHeadings } from '../plugins/add-id-to-headings';

export type Changelog = {
  title: string;
  description: string;
  image: string;
  publishedAt: Date;
  mdx: string;
  slug: string;
  readingTime: string;
};

export const changelogs = defineCollection({
  name: "Changelogs",
  directory: "src/content/changelog",
  include: "*/index.mdx",
  schema: (z) => ({
    title: z.string(),
    description: z.string(),
    image: z.string(),
    publishedAt: z.coerce.date(),
  }),
  transform: async (document, context) => {
    const mdx = await compileMDX(context, document, {
      rehypePlugins: [addIdToHeadings],
    });
    return {
      ...document,
      mdx,
      slug: document._meta.fileName.replace(/\.mdx$/, ""),
      readingTime: readingTime(document.content).text,
    };
  },
});

export type ChangelogCollectionType = typeof changelogs;
