import remarkGfm from 'remark-gfm';
import type * as unified from 'unified';

export const addGithubFlavouredMd: unified.Pluggable<any[]> = [remarkGfm];
