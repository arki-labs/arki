/** The 50-command fixture on `@arki/cli`: 10 lazy groups of 5 lazy commands each. */
import { defineCli, run } from '../../src/index.js';
import { VERSION } from './tree-data.js';

await run(
  defineCli({
    name: 'fifty',
    version: VERSION,
    describe: 'A 50-command fixture',
    commands: {
      users: () => import('./fifty/users.js'),
      posts: () => import('./fifty/posts.js'),
      media: () => import('./fifty/media.js'),
      billing: () => import('./fifty/billing.js'),
      search: () => import('./fifty/search.js'),
      jobs: () => import('./fifty/jobs.js'),
      cache: () => import('./fifty/cache.js'),
      deploy: () => import('./fifty/deploy.js'),
      bench: () => import('./fifty/bench.js'),
      admin: () => import('./fifty/admin.js'),
    },
  }),
);
