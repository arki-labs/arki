/**
 * Fleet endpoint handler for Arki.
 *
 * Binds the app's snapshot to the shared, token-gated request handler from
 * `@arki/admin/server`. Mounted by the start app at `GET /api/fleet`.
 */
import { createFleetHandler } from '@arki/admin/server';

import { env } from '../../env';
import { getFleetSnapshot } from './snapshot';

export const fleetHandler = createFleetHandler({
  token: env.FOREMAN_TOKEN,
  snapshot: getFleetSnapshot,
});
