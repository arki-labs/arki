import { describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, AdminError } from '../../errors';
import { APP_UUID, applications, DEPLOY_UUID, deployment, SERVER_UUID, servers, unreachableServer } from './fixtures';
import { confirmHint, createCoolifyClient, parseWebhookHint, verifyWebhookSecret } from './index';

const TOKEN = '12|super-secret-token-value';
const BASE = 'https://coolify.example.invalid';

type Routes = Record<string, { status?: number; body: unknown; text?: boolean }>;

/** Replays fixtures by request path. Records every call so tests can assert reads only. */
function replay(routes: Routes) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const impl = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ url: url.pathname + url.search, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    const route = routes[url.pathname];
    if (route === undefined) return Promise.resolve(new Response('{"message":"Not found."}', { status: 404 }));
    const text = route.text === true ? String(route.body) : JSON.stringify(route.body);
    return Promise.resolve(new Response(text, { status: route.status ?? 200 }));
  };
  return { fetch: vi.fn(impl), calls };
}

const clientFor = (routes: Routes) => {
  const r = replay(routes);
  return { client: createCoolifyClient({ baseUrl: BASE, token: TOKEN, fetch: r.fetch }), ...r };
};

const fullRoutes: Routes = {
  '/api/v1/applications': { body: applications },
  [`/api/v1/applications/${APP_UUID}`]: { body: applications[0] },
  [`/api/v1/deployments/applications/${APP_UUID}`]: { body: { count: 1, deployments: [deployment] } },
  [`/api/v1/deployments/${DEPLOY_UUID}`]: { body: deployment },
  '/api/v1/servers': { body: servers },
  [`/api/v1/servers/${SERVER_UUID}`]: { body: servers[0] },
  '/api/v1/version': { body: '"v4.0.0-beta.434"', text: true },
};

describe('coolify-conformance: fixture replay', () => {
  it('reads applications, deployments, servers and the version, GET only, with the bearer token', async () => {
    const { client, calls } = clientFor(fullRoutes);
    const apps = await client.listApplications();
    const app = await client.getApplication(APP_UUID);
    const deploys = await client.listDeployments(APP_UUID, { take: 5 });
    const list = await client.listServers();
    const one = await client.getServer(SERVER_UUID);
    expect(apps[0]?.uuid).toBe(APP_UUID);
    expect(app.name).toBe('example-web');
    expect(deploys[0]?.deployment_uuid).toBe(DEPLOY_UUID);
    expect(list[0]?.uuid).toBe(SERVER_UUID);
    expect(one.name).toBe('example-server');
    expect(await client.probeVersion()).toEqual({ version: 'v4.0.0-beta.434', major: 4, supported: true });
    expect(calls.every(c => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.some(c => c.url.endsWith('?skip=0&take=5'))).toBe(true);
  });

  it('accepts a bare array deployment list and flags an unsupported major version', async () => {
    const { client } = clientFor({
      [`/api/v1/deployments/applications/${APP_UUID}`]: { body: [deployment] },
      '/api/v1/version': { body: '5.1.0', text: true },
    });
    expect(await client.listDeployments(APP_UUID)).toHaveLength(1);
    const probe = await client.probeVersion();
    expect(probe.supported).toBe(false);
  });
});

describe('coolify-conformance: schema drift', () => {
  it('a missing required field is a coded invalidOutput error naming the field, not the value', async () => {
    const { client } = clientFor({ '/api/v1/applications': { body: [{ name: 'no-uuid', secretish: 'leak-me' }] } });
    const error = await client.listApplications().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(AdminError);
    expect(error).toMatchObject({ code: ADMIN_ERROR_CODES.invalidOutput });
    expect(String((error as Error).message)).toContain('0.uuid');
    expect(String((error as Error).message)).not.toContain('leak-me');
  });

  it('maps 401, 404 and server errors to codes', async () => {
    const { client } = clientFor({ '/api/v1/servers': { status: 401, body: { message: 'Unauthenticated.' } } });
    await expect(client.listServers()).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.unauthenticated });
    await expect(client.getServer('nope')).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.unknownCapability });
    const bad = clientFor({ '/api/v1/applications': { status: 500, body: {} } });
    await expect(bad.client.listApplications()).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.unreachable });
  });

  it('rejects bad options at construction', () => {
    expect(() => createCoolifyClient({ baseUrl: 'not a url', token: TOKEN, fetch })).toThrow(AdminError);
    expect(() => createCoolifyClient({ baseUrl: BASE, token: '', fetch })).toThrow(AdminError);
  });
});

describe('coolify-conformance: webhooks are hints', () => {
  const now = new Date('2026-01-02T03:05:00Z');

  it('a spoofed webhook for a resource the API does not know yields no signal', async () => {
    const { client } = clientFor(fullRoutes);
    const hint = parseWebhookHint({ event: 'deployment_failed', deployment_uuid: 'forged0000uuid' }, now);
    expect(hint).toMatchObject({ kind: 'deployment', resourceUuid: 'forged0000uuid', receivedAt: now });
    expect(await confirmHint(client, hint)).toEqual([]);
  });

  it('a webhook claiming a failure for a healthy resource produces no signal', async () => {
    const { client } = clientFor(fullRoutes);
    const hint = parseWebhookHint({ event: 'server_unreachable', server_uuid: SERVER_UUID, message: 'FAKE' }, now);
    expect(await confirmHint(client, hint)).toEqual([]);
  });

  it('a confirmed webhook becomes a signal built from API data, not webhook text', async () => {
    const { client } = clientFor(fullRoutes);
    const hint = parseWebhookHint({ event: 'deployment_failed', deployment_uuid: DEPLOY_UUID, message: 'LIES' }, now);
    const [signal, ...rest] = await confirmHint(client, hint);
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({
      source: 'coolify',
      kind: 'deploy.failed',
      severity: 'error',
      externalId: `deployment:${DEPLOY_UUID}:failed`,
      summary: 'Deployment of example-web is failed',
      occurredAt: new Date('2026-01-02T03:04:05Z'),
    });
    expect(JSON.stringify(signal)).not.toContain('LIES');
  });

  it('confirms an unreachable server from the API', async () => {
    const { client } = clientFor({ [`/api/v1/servers/${SERVER_UUID}`]: { body: unreachableServer } });
    const [signal] = await confirmHint(client, parseWebhookHint({ server_uuid: SERVER_UUID }, now));
    expect(signal).toMatchObject({ kind: 'server.unreachable', severity: 'critical' });
  });

  it('rethrows a rejected token instead of hiding it', async () => {
    const { client } = clientFor({ [`/api/v1/deployments/${DEPLOY_UUID}`]: { status: 403, body: {} } });
    await expect(confirmHint(client, parseWebhookHint({ deployment_uuid: DEPLOY_UUID }, now))).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.unauthenticated,
    });
  });

  it('refuses bodies that name no resource; verifies the optional secret in constant time', () => {
    expect(() => parseWebhookHint({ event: 'x' }, now)).toThrow(AdminError);
    expect(() => parseWebhookHint('nope', now)).toThrow(AdminError);
    expect(verifyWebhookSecret('s3cret', 's3cret')).toBe(true);
    expect(verifyWebhookSecret('s3creT', 's3cret')).toBe(false);
    expect(verifyWebhookSecret(null, 's3cret')).toBe(false);
    expect(verifyWebhookSecret('', '')).toBe(false);
  });
});

describe('coolify-conformance: the token never leaks', () => {
  it('is absent from errors and from the log sink on every failure path', async () => {
    const spy = vi.spyOn(console, 'log').mockReturnValue();
    const throwing = createCoolifyClient({
      baseUrl: BASE,
      token: TOKEN,
      fetch: () => Promise.reject(new Error(`boom with Bearer ${TOKEN}`)),
    });
    const denied = clientFor({ '/api/v1/servers': { status: 401, body: {} } });
    const drift = clientFor({ '/api/v1/applications': { body: [{}] } });
    const errors = await Promise.all([
      throwing.listServers().catch((error: unknown) => error),
      denied.client.listServers().catch((error: unknown) => error),
      drift.client.listApplications().catch((error: unknown) => error),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(AdminError);
      const err = e as AdminError;
      expect(
        `${err.message} ${err.remediation} ${String(err.stack)} ${JSON.stringify(err.cause ?? null)}`,
      ).not.toContain('super-secret');
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret');
    spy.mockRestore();
  });
});
