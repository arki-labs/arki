/**
 * The fleet route after its contract became `raw()`: the handler still owns
 * its 200/401/500/502 answers, and the contract still documents the payload.
 */
import { describe, expect, it } from 'vitest';

import { buildEngine, toOpenApi } from '@arki/http';

import type { FleetSnapshot } from './contract';
import { FLEET_ENDPOINT_PATH } from './contract';
import { fleetRoutes, fleetSnapshotRoute } from './http';

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

  it('keeps the handler error formats: 401 without a token, 502 when the provider throws, 500 on a bad snapshot', async () => {
    const unauthorized = await ask(() => snapshot);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' });

    const failed = await ask(() => {
      throw new Error('db down');
    }, `Bearer ${TOKEN}`);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'snapshot_failed', detail: 'db down' });

    const invalid = await ask(() => ({ ...snapshot, generatedAt: '' }), `Bearer ${TOKEN}`);
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_snapshot' });
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
