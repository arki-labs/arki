import { afterEach, describe, expect, it, vi } from 'vitest';

import { createE2EHandler } from './e2e-handler';

function fakeAuth() {
  const internalAdapter = {
    findUserByEmail: vi.fn(async () => ({ user: { id: 'usr_existing' } })),
    deleteUser: vi.fn((_userId: string) => Promise.resolve()),
  };
  const handler = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    return Response.json(
      { path },
      {
        status: 200,
        headers: { 'set-cookie': 'session=signed; Path=/' },
      },
    );
  });
  return {
    auth: { handler, $context: { baseURL: 'http://localhost:3000', options: {}, internalAdapter } },
    handler,
    internalAdapter,
  };
}

const post = (body: unknown) =>
  new Request('http://localhost:3000/api/e2e/create-session', { method: 'POST', body: JSON.stringify(body) });

describe('createE2EHandler', () => {
  afterEach(() => vi.unstubAllEnvs());

  // The handler deletes and re-creates the account it is given. A refused address must never reach that step,
  // or anyone who can reach a non-production server could reset a real person's account.
  it('refuses addresses outside allowEmail before looking up or deleting any account', async () => {
    const { auth, handler, internalAdapter } = fakeAuth();
    const mint = createE2EHandler({
      auth,
      defaultEmail: 'e2e@app.test',
      allowEmail: email => email.endsWith('@app.test'),
    });

    const response = await mint({ request: post({ email: 'founder@real-company.com' }) });

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(internalAdapter.findUserByEmail).not.toHaveBeenCalled();
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  // Leaving allowEmail out must not open the endpoint to every address: the handler deletes the account it is
  // given, so the default has to refuse anything that could be a real mailbox.
  it('refuses a real-looking address when allowEmail is omitted', async () => {
    const { auth, handler, internalAdapter } = fakeAuth();
    const mint = createE2EHandler({ auth, defaultEmail: 'e2e@app.test' });

    const refused = await mint({ request: post({ email: 'founder@real-company.com' }) });

    expect(refused.status).toBe(403);
    expect(internalAdapter.findUserByEmail).not.toHaveBeenCalled();
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    const allowed = await mint({ request: post({ email: 'someone@app.test' }) });
    expect(allowed.status).toBe(200);
  });

  it('signs an allowed test address up and in', async () => {
    const { auth, handler } = fakeAuth();
    const mint = createE2EHandler({
      auth,
      defaultEmail: 'e2e@app.test',
      allowEmail: email => email.endsWith('@app.test'),
    });

    const response = await mint({ request: post({}) });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('session=signed');
    expect(handler.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      '/api/auth/sign-up/email',
      '/api/auth/sign-in/email',
    ]);
  });

  it('does nothing in production, whatever the address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { auth, handler, internalAdapter } = fakeAuth();
    const mint = createE2EHandler({ auth, defaultEmail: 'e2e@app.test' });

    const response = await mint({ request: post({ email: 'e2e@app.test' }) });

    expect(response.status).toBe(404);
    expect(internalAdapter.findUserByEmail).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
