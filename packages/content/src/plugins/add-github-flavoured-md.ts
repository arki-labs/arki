import type * as unified from 'unified';
import remarkGfm from 'remark-gfm';

export const addGithubFlavouredMd: unified.Pluggable = [remarkGfm];
