import type { Post } from '../collections/post';

export type PostOverview = Pick<Post, 'url' | 'title' | 'description' | 'publishedAt' | 'readingTime' | 'image'>;
