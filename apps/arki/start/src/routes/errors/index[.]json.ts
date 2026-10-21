import { createFileRoute } from '@tanstack/react-router';

import { listErrorsFn } from '~/features/site-data/site-data';

export const Route = createFileRoute('/errors/index.json')({
  server: {
    handlers: {
      GET: async () => Response.json(await listErrorsFn(), { headers: { 'cache-control': 'public, max-age=300' } }),
    },
  },
});
