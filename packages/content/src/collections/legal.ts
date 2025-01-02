import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import rehypeSlug from 'rehype-slug';
import { prettyCode } from '../plugins/pretty-code';
import { autolinkHeadings } from '../plugins/autolink-headings';

export type Legal = {
  title: string;
  updatedAt: string;
  mdx: string;
  slug: string;
};

export const legals = defineCollection({
  name: "Legals",
  directory: "src/content/legal",
  include: "**/*.mdx",
  schema: (z) => ({
    title: z.string(),
    updatedAt: z.string(),
  }),
  transform: async (document, context) => {
    const mdx = await compileMDX(context, document, {
      rehypePlugins: [rehypeSlug, prettyCode, autolinkHeadings],
    });
    return {
      ...document,
      mdx,
      slug: document._meta.fileName.replace(/\.mdx$/, ""),
    };
  },
});

export type LegalCollectionType = typeof legals;
