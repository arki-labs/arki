/**
 * Rate limits reach the wire, are shared by replicas, fail closed, and key on the trusted client
 * address only. Brute force on sign-in is the attack these tests stand in for.
 */
import { describe, expect, it } from 'vitest';

import { PASSWORD, post } from '../../__fixtures__/http.js';
import { failingStore, sharedStore } from '../../__fixtures__/rate-limit-store.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { AUTH_ERROR_CODES } from '../../errors.js';
import { testAuth } from '../../testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });

const signIn = (auth: { handler: (request: Request) => Promise<Response> }, headers?: HeadersInit) =>
  post(
    auth,
    '/sign-in/email',
    { email: 'ada@notes.test', password: PASSWORD },
    headers ?? { 'cf-connecting-ip': '203.0.113.7' },
  );

describe('rate limits', () => {
  it('answers the 4th sign-in in 10 s with 429 and Retry-After', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { clientIp: { header: 'cf-connecting-ip' } },
    });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await signIn(auth);
        statuses.push(response.status);
      }
      expect(statuses).not.toContain(429);
      const refused = await signIn(auth);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it('two instances on one store share one budget', async () => {
    const store = sharedStore();
    const { auth, rebuild, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store },
      runtime: { clientIp: { header: 'cf-connecting-ip' } },
    });
    try {
      const replica = rebuild();
      await signIn(auth);
      await signIn(replica);
      await signIn(auth);
      await expect(signIn(replica)).resolves.toHaveProperty('status', 429);
    } finally {
      await dispose();
    }
  });

  it('answers 503 E503 when the store fails, never a pass', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: failingStore() },
    });
    try {
      const response = await signIn(auth);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: AUTH_ERROR_CODES.storeUnavailable });
    } finally {
      await dispose();
    }
  });

  it('`rateLimit: false` turns limiting off', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: false });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await signIn(auth);
        statuses.push(response.status);
      }
      expect(statuses).not.toContain(429);
    } finally {
      await dispose();
    }
  });

  it('a spoofed x-forwarded-for does not pick a new bucket when clientIp.header is set', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { clientIp: { header: 'cf-connecting-ip' } },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await signIn(auth, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': `198.51.100.${attempt}` });
      }
      const refused = await signIn(auth, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.99' });
      expect(refused.status).toBe(429);
      const otherClient = await signIn(auth, { 'cf-connecting-ip': '203.0.113.8' });
      expect(otherClient.status).not.toBe(429);
    } finally {
      await dispose();
    }
  });
});
