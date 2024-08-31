import type * as unified from 'unified';
import rehypeSlug from 'rehype-slug';

export const addIdToHeadings: unified.Pluggable = [rehypeSlug];
