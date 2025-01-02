import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import rehypeSlug from 'rehype-slug';
import { prettyCode } from '../plugins/pretty-code';
import { autolinkHeadings } from '../plugins/autolink-headings';

export const faqs = defineCollection({
  name: "FAQs",
  directory: "src/content/faq",
  include: "**/*.mdx",
  schema: (z) => ({
    title: z.string(),
    order: z.number(),
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
