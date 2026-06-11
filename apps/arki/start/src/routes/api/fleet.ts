import { createFileRoute } from '@tanstack/react-router';

import { fleetHandler } from '@arki/backend/fleet';

/**
 * Fleet endpoint — Foreman (admin.fork.works) reads this app's snapshot here.
 * Gated by a Bearer `FOREMAN_TOKEN`; see `@arki/admin/server`.
 */
export const Route = createFileRoute('/api/fleet')({
  server: {
    handlers: {
      GET: ({ request }) => fleetHandler(request),
    },
  },
});
