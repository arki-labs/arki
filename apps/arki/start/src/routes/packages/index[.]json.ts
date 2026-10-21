import { createFileRoute } from '@tanstack/react-router';

import { listPackagesFn } from '~/features/site-data/site-data';

/** The package list (`src/generated/packages.json`) as JSON, for agents and scripts. */
export const Route = createFileRoute('/packages/index.json')({
  server: {
    handlers: {
      GET: async () => Response.json(await listPackagesFn()),
    },
  },
});
