/**
 * Foreman protocol 2 (`/api/foreman/*`), served by `start/src/routes/api/foreman/$.ts`. Signed requests
 * only. It answers 404 until the `FOREMAN_*` keys are set (see `@arki/admin` README). The nonces and
 * receipts live in the app's KV. `core.health` reuses the `/api/fleet` snapshot.
 */
import { createForemanRoute } from '@arki/admin/server';

import { version } from '../../../package.json';
import { env } from '../../env';
import { kv } from '../../kv';
import { getFleetSnapshot } from './snapshot';

export const foremanRoute = createForemanRoute(() => ({
  env,
  app: { version, commit: env.SOURCE_COMMIT },
  store: kv,
  context: () => ({}),
  health: async () => {
    const snapshot = await getFleetSnapshot();
    return snapshot.health;
  },
}));
