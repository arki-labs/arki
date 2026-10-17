import * as generated from 'content-collections';

import { contentQueries } from '@arki/content';

export const { posts, changelogs, legals, faqs, changelogBySlug } = contentQueries(generated);
