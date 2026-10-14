import type { Meta } from '@content-collections/core';

export type Post = {
  title: string;
  description: string;
  publishedAt: Date;
  author: {
    name: string;
    url?: string;
    avatar?: string;
  };
  tags: string[];
  content: {
    mdx: string;
    raw: string;
  };
  readingTime: string;
  lastModification: string;
  image: {
    url: string;
    blurDataURL: string;
  };
  url: string;
  slug: string;
  _meta: Meta;
};

export type Changelog = {
  title: string;
  description: string;
  publishedAt: Date;
  content: {
    mdx: string;
    raw: string;
  };
  image: {
    url: string;
    blurDataURL: string;
  };
  url: string;
  slug: string;
  _meta: Meta;
};

export type Faq = {
  title: string;
  order: number;
  mdx: string;
  slug: string;
};

export type Legal = {
  title: string;
  updatedAt: string;
  mdx: string;
  slug: string;
};

/** The fields search results show for a post. */
export type PostOverview = Pick<Post, 'url' | 'title' | 'description' | 'publishedAt' | 'readingTime' | 'image'>;
