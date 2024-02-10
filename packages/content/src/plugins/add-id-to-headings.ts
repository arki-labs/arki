import rehypeSlug from 'rehype-slug';
import type * as unified from 'unified';

export const addIdToHeadings: unified.Pluggable = [rehypeSlug];
