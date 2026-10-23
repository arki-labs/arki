import { foremanRoute } from '@arki/backend/foreman';
import { createFileRoute } from '@tanstack/react-router';

/** Foreman protocol 2. Signed requests only; answers 404 until the `FOREMAN_*` keys are set. */
export const Route = createFileRoute('/api/foreman/$')({
  server: {
    handlers: {
      ANY: ({ request }) => foremanRoute(request),
    },
  },
});
