import { createFileRoute } from '@tanstack/react-router';

import { serverApp } from '../../live.server';

/** The e2e readiness probe: 200 once the hub listens, 503 before. Starts the hub on the first call. */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const app = await serverApp();
        const status = app.hub.status();
        return new Response(status, { status: status === 'ready' ? 200 : 503 });
      },
    },
  },
});
