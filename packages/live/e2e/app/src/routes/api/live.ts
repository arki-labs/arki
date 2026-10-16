import { createFileRoute } from '@tanstack/react-router';

import { serverApp } from '../../live.server';

/** The live stream as a TanStack Start server route: the README's `GET: ({ request }) => endpoint.fetch(request)`. */
export const Route = createFileRoute('/api/live')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const app = await serverApp();
        return app.endpoint.fetch(request);
      },
    },
  },
});
