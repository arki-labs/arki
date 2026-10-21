import { allChangelogs, allFAQs, allLegals, allPosts } from 'content-collections';

import { contentQueries } from '@arki/content';

// Named imports, not `import * as`: the bundler then leaves the other collections (the compiled package docs)
// out of every page that reads posts, changelogs or legal pages.
export const { posts, changelogs, legals, faqs, changelogBySlug } = contentQueries({
  allPosts,
  allChangelogs,
  allLegals,
  allFAQs,
});
