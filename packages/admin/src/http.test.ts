/**
 * The fleet route after its contract became `raw()`: the handler still owns
 * its 200/401/500/502 answers, and the contract still documents the payload.
 */
import { describe, expect, it } from 'vitest';

import { buildEngine, toOpenApi } from '@arki/http';

import type { FleetSnapshot } from './contract';
import { FLEET_ENDPOINT_PATH } from './contract';
import { AdminInvalidOutput, AdminUnauthenticated, AdminUnreachable } from './failures';
import { fleetRoutes, fleetSnapshotRoute } from './http';
import { fetchFleetSnapshot } from './server';

const TOKEN = 'fleet-secret';
const URL_ = `https://novelette.test${FLEET_ENDPOINT_PATH}`;

const snapshot: FleetSnapshot = {
  info: {
    id: 'novelette',
    brand: 'Novelette',
    domain: 'novelette.test',
    version: '1.0.0',
    environment: 'production',
    protocolVersion: 1,
  },
  metrics: { users: { total: 3, new7d: 1, new30d: 2 }, custom: [] },
  health: { status: 'ok', checks: [] },
  generatedAt: '2026-10-16T00:00:00Z',
};

function ask(provider: () => FleetSnapshot | Promise<FleetSnapshot>, authorization?: string): Promise<Response> {
  const engine = buildEngine([fleetRoutes({ token: TOKEN, snapshot: provider })]);
  return engine.fetch(new Request(URL_, authorization === undefined ? {} : { headers: { authorization } }));
}

describe('fleet snapshot route', () => {
  it('serves the snapshot as JSON with a valid token', async () => {
    const res = await ask(() => snapshot, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
  });

  // WHY: the fleet token opens the endpoint to Foreman, not to the app's internals. A provider error
  // ("db down at db-7") or a schema problem must reach the log, never the caller.
  it('answers 401 without a token, 502 when the provider throws and 500 on a bad snapshot, with no internal text', async () => {
    const unauthorized = await ask(() => snapshot);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' });

    const failed = await ask(() => {
      throw new Error('db down at db-7');
    }, `Bearer ${TOKEN}`);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'snapshot_failed' });

    const invalid = await ask(() => ({ ...snapshot, generatedAt: '' }), `Bearer ${TOKEN}`);
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toEqual({ error: 'invalid_snapshot' });
  });

  it('documents the snapshot payload and marks the route raw', () => {
    const document = toOpenApi([fleetSnapshotRoute], { title: 'fleet', version: '1.0.0' });
    const operation = (document['paths'] as Record<string, Record<string, Record<string, unknown>>>)[FLEET_ENDPOINT_PATH]?.[
      'get'
    ];
    expect(operation?.['x-arki-raw']).toBe(true);
    expect(operation?.['responses']).toMatchObject({
      '200': { content: { 'application/json': { schema: { type: 'object', required: expect.arrayContaining(['info']) as string[] } } } },
    });
  });
});

describe('fetchFleetSnapshot returns typed failures and never throws', () => {
  const entry = { id: 'novelette', brand: 'Novelette', domain: 'novelette.test', baseUrl: 'https://novelette.test', token: 't' };
  const answering = (response: () => Response | Promise<Response>) => ({ fetch: () => Promise.resolve().then(response) });

  it('a snapshot that matches the contract is returned', async () => {
    const result = await fetchFleetSnapshot(entry, answering(() => Response.json(snapshot)));
    expect(result).toMatchObject({ id: 'novelette', ok: true });
  });

  it.each([
    [401, AdminUnauthenticated.code],
    [403, AdminUnauthenticated.code],
    [500, AdminUnreachable.code],
  ])('HTTP %i is %s', async (status, code) => {
    const result = await fetchFleetSnapshot(entry, answering(() => new Response('internal text', { status })));
    expect(result).toMatchObject({ ok: false, failure: { code } });
  });

  it('a body outside the contract is AdminInvalidOutput', async () => {
    const result = await fetchFleetSnapshot(entry, answering(() => Response.json({ nope: true })));
    expect(result).toMatchObject({ ok: false, failure: { code: AdminInvalidOutput.code } });
  });

  it('a network error is AdminUnreachable with the error as its private cause, not its message', async () => {
    const result = await fetchFleetSnapshot(entry, {
      fetch: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:443')),
    });
    expect(result).toMatchObject({ ok: false, failure: { code: AdminUnreachable.code } });
    expect(JSON.stringify(result)).not.toContain('10.0.0.7');
  });
});
