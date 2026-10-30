/**
 * The e2e session route is no deployed backdoor: absent unless enabled, test addresses only,
 * malformed bodies refused, and refused again by the auth itself in production.
 */
import { eq } from 'drizzle-orm';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestAuth } from './index.js';
import { post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { testAuth } from './index.js';
import { createE2EHandler } from './tanstack-start.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });
let harness: TestAuth<typeof definition, typeof authTables>;
beforeAll(async () => {
  harness = await testAuth(definition, { tables: authTables });
});
afterAll(() => harness.dispose());

const call = (handler: ReturnType<typeof createE2EHandler>, body?: string) =>
  handler({ request: new Request('http://localhost:3000/api/test/session', { method: 'POST', body }) });

describe('createE2EHandler', () => {
  it('is absent (404) unless enabled', async () => {
    const handler = createE2EHandler({ auth: harness.auth, defaultEmail: 'e2e@notes.test' });
    await expect(call(handler)).resolves.toHaveProperty('status', 404);
  });

  it('touches no account when not enabled, whatever the body asks', async () => {
    const handler = createE2EHandler({
      auth: harness.auth,
      enabled: false,
      defaultEmail: 'e2e@notes.test',
      password: 'e2e-test-password-1234',
    });
    const response = await call(handler, JSON.stringify({ email: 'off@notes.test' }));
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await harness.db.select().from(authTables.User).where(eq(authTables.User.email, 'off@notes.test'))).toEqual(
      [],
    );
  });

  it('with `password`, the same user can then sign in through the form', async () => {
    // Form-driven specs (sign-in page) reuse the account the route made, by its known password.
    const handler = createE2EHandler({
      auth: harness.auth,
      enabled: true,
      defaultEmail: 'e2e@notes.test',
      password: 'e2e-test-password-1234',
    });
    await expect(call(handler)).resolves.toHaveProperty('status', 200);
    const signIn = await post(harness.auth, '/sign-in/email', {
      email: 'e2e@notes.test',
      password: 'e2e-test-password-1234',
    });
    expect(signIn.status).toBe(200);
  });

  it('signs in a test address and sets a working session cookie', async () => {
    const handler = createE2EHandler({ auth: harness.auth, enabled: true, defaultEmail: 'e2e@notes.test' });
    const response = await call(handler, JSON.stringify({ email: 'pw@notes.test' }));
    expect(response.status).toBe(200);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    await expect(harness.auth.principal(new Headers({ cookie }))).resolves.toMatchObject({
      user: { email: 'pw@notes.test' },
    });
  });

  it('refuses an address outside the .test domain before touching any account', async () => {
    const handler = createE2EHandler({ auth: harness.auth, enabled: true, defaultEmail: 'e2e@notes.test' });
    const response = await call(handler, JSON.stringify({ email: 'ceo@company.com' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ version: 1, code: 'auth.forbidden' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses malformed bodies', async () => {
    const handler = createE2EHandler({ auth: harness.auth, enabled: true, defaultEmail: 'e2e@notes.test' });
    for (const body of ['not json', '[]', JSON.stringify({ email: 42 }), JSON.stringify({ email: '' })]) {
      const response = await call(handler, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ version: 1, code: 'schema.invalid_input' });
    }
  });

  it('answers 404 when the auth runs in production, even if enabled', async () => {
    const production = harness.rebuild({
      rateLimit: { store: { getRateLimiter: () => new RateLimiterMemory({ points: 100, duration: 10 }) } },
      runtime: { production: true },
    });
    const handler = createE2EHandler({ auth: production, enabled: true, defaultEmail: 'e2e@notes.test' });
    const response = await call(handler);
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
