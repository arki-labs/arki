/**
 * Arki fleet snapshot.
 *
 * Computes the {@link FleetSnapshot} Foreman reads from `/api/fleet`. Uses the
 * core query builder (not `db.query.*` RQB) so a relational quirk can never take
 * the endpoint down. Every failure is caught and reported as a health check
 * rather than thrown — a degraded app should still appear in the fleet view.
 */
import { count, gte } from 'drizzle-orm';

import type { FleetSnapshot } from '@arki/admin';
import { FLEET_PROTOCOL_VERSION } from '@arki/admin';

import { db } from '../../db';
import { env } from '../../env';
import { User } from '../auth/schema';

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Public domain derived from the app's production URL, scheme stripped. */
const domain = (env.PRODUCTION_URL ?? env.VITE_URL).replace(/^https?:\/\//, '');

/** Map NODE_ENV onto the fleet contract's environment enum. */
const environment: FleetSnapshot['info']['environment'] =
  env.NODE_ENV === 'production' ? 'production' : 'development';

export async function getFleetSnapshot(): Promise<FleetSnapshot> {
  const checks: FleetSnapshot['health']['checks'] = [];
  let total = 0;
  let new7d = 0;
  let new30d = 0;
  let dbOk = true;

  try {
    const [totalRows, weekRows, monthRows] = await Promise.all([
      db.select({ value: count() }).from(User),
      db
        .select({ value: count() })
        .from(User)
        .where(gte(User.createdAt, daysAgo(7))),
      db
        .select({ value: count() })
        .from(User)
        .where(gte(User.createdAt, daysAgo(30))),
    ]);
    total = totalRows[0]?.value ?? 0;
    new7d = weekRows[0]?.value ?? 0;
    new30d = monthRows[0]?.value ?? 0;
    checks.push({ name: 'database', ok: true });
  } catch (error) {
    dbOk = false;
    checks.push({
      name: 'database',
      ok: false,
      detail: error instanceof Error ? error.message : 'user query failed',
    });
  }

  return {
    info: {
      id: 'arki',
      brand: 'Arki',
      domain,
      version: env.NODE_ENV === 'production' ? 'release' : 'dev',
      environment,
      protocolVersion: FLEET_PROTOCOL_VERSION,
    },
    metrics: {
      users: { total, new7d, new30d },
      custom: [],
    },
    health: {
      status: dbOk ? 'ok' : 'down',
      checks,
    },
    generatedAt: new Date().toISOString(),
  };
}
