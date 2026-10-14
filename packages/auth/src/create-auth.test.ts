import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertAuthSecret, AUTH_SECRET_MIN_LENGTH, betterAuth } from './create-auth';

const SECRET_A = 'secret-a-0123456789abcdefghijklmnopqrstuv';
const SECRET_B = 'secret-b-zyxwvutsrqponmlkjihgfedcba987654';

type MemoryDb = Parameters<typeof memoryAdapter>[0];

// Both instances share ONE store on purpose. A session row made by A is then
// visible to B, so the only thing that can stop B from accepting A's cookie is
// the signature check with B's own secret. That is the isolation under test.
function makeAuth(db: MemoryDb, secret: string, baseURL: string) {
  return betterAuth({
    secret,
    baseURL,
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
  });
}

async function signUp(auth: ReturnType<typeof makeAuth>, email: string): Promise<Headers> {
  const response = await auth.api.signUpEmail({
    body: { email, password: 'correct horse battery staple', name: 'Test User' },
    asResponse: true,
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  const sessionCookie = setCookie.split(/,(?=\s*[\w.-]+=)/).find(part => part.includes('session_token='));
  expect(sessionCookie).toBeDefined();
  return new Headers({ cookie: (sessionCookie ?? '').split(';')[0] ?? '' });
}

describe('betterAuth wrapper: secret isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps two instances with different secrets and base URLs apart', async () => {
    const envBefore = { ...process.env };
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };

    const authA = makeAuth(db, SECRET_A, 'http://localhost:4101');
    const authB = makeAuth(db, SECRET_B, 'http://localhost:4102');

    // A was built first. If building B had leaked B's secret into a shared global,
    // A would now reject its own cookie, so check A after B exists.
    const cookieFromA = await signUp(authA, 'a@example.com');
    const cookieFromB = await signUp(authB, 'b@example.com');

    const sessionA = await authA.api.getSession({ headers: cookieFromA });
    const sessionB = await authB.api.getSession({ headers: cookieFromB });
    expect(sessionA?.user.email).toBe('a@example.com');
    expect(sessionB?.user.email).toBe('b@example.com');

    // The session rows exist in the shared store, yet each instance refuses the other's cookie.
    expect(await authB.api.getSession({ headers: cookieFromA })).toBeNull();
    expect(await authA.api.getSession({ headers: cookieFromB })).toBeNull();

    // Building and using the instances wrote nothing to the process environment (the old wrapper set the secret there).
    expect({ ...process.env }).toEqual(envBefore);
  });
});

describe('assertAuthSecret: weak secrets in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a secret shorter than 32 characters in production', () => {
    const short = 'x'.repeat(AUTH_SECRET_MIN_LENGTH - 1);
    expect(() => assertAuthSecret(short, 'production')).toThrow(/too short \(31 characters\).*at least 32/);
  });

  it('refuses a missing secret in production', () => {
    expect(() => assertAuthSecret(undefined, 'production')).toThrow(/secret is missing/);
    expect(() => assertAuthSecret('', 'production')).toThrow(/secret is missing/);
  });

  it('accepts a 32-character secret in production', () => {
    expect(() => assertAuthSecret('x'.repeat(AUTH_SECRET_MIN_LENGTH), 'production')).not.toThrow();
  });

  it('lets dev and test use a short secret, so local setup stays simple', () => {
    expect(() => assertAuthSecret('short', 'development')).not.toThrow();
    expect(() => assertAuthSecret('short', 'test')).not.toThrow();
  });

  it('runs inside the betterAuth wrapper, before Better Auth is built', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    expect(() => makeAuth(db, 'too-short-secret', 'http://localhost:4103')).toThrow(/too short/);
  });
});
