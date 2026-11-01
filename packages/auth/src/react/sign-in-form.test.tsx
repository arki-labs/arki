import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AuthDefinition } from '../definition.js';
import type { SignInCapableAuthClient, SignInHandlers } from './sign-in-form.js';
import { SignInRefused } from '../boundary-failures.js';
import { defineAuth } from '../definition.js';
import { createSignInHandlers, SignInForm } from './sign-in-form.js';

const handlers: SignInHandlers = {
  onMagicLink: () => Promise.resolve(),
  onPasswordSignIn: () => Promise.resolve(),
  onSocialSignIn: () => Promise.resolve(),
};

const render = (definition: AuthDefinition) =>
  // `createElement`, not JSX: the package compiles with `jsx: preserve`, which the test runner does not transform.
  renderToStaticMarkup(createElement(SignInForm, { definition, handlers }));

const app = { name: 'Notes', key: 'notes' };

describe('SignInForm', () => {
  it('renders a button for each enabled social provider and none for the others', () => {
    // A button for a provider the server has not enabled would be a dead end for the user.
    const html = render(defineAuth({ app, methods: ['magicLink', 'google', 'github'] }));
    expect(html).toContain('Sign in with Google');
    expect(html).toContain('Sign in with GitHub');
    expect(html).not.toContain('Sign in with Apple');
    expect(html).not.toContain('Sign in with Facebook');
    expect(html).not.toContain('Sign in with Microsoft');
  });

  it('opens on the magic link and offers the password toggle when both are on', () => {
    const html = render(defineAuth({ app, methods: ['password', 'magicLink'] }));
    expect(html).toContain('Send sign-in link');
    expect(html).toContain('Sign in with password');
    expect(html).not.toContain('or continue with');
  });

  it('shows no magic-link controls when only passwords are on', () => {
    const html = render(defineAuth({ app, methods: ['password'] }));
    expect(html).not.toContain('Send sign-in link');
    expect(html).not.toContain('Sign in with magic link');
    expect(html).toContain('type="password"');
  });

  it('shows no password controls when only magic links are on', () => {
    const html = render(defineAuth({ app, methods: ['magicLink'] }));
    expect(html).toContain('Send sign-in link');
    expect(html).not.toContain('Sign in with password');
    expect(html).not.toContain('type="password"');
  });

  it('shows only the social buttons when no email method is on', () => {
    const html = render(defineAuth({ app, methods: ['apple'] }));
    expect(html).toContain('Sign in with Apple');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('or continue with');
  });
});

describe('createSignInHandlers', () => {
  // WHY: a failed sign-in used to become `new Error(server text)`, so a wrong password, an unverified
  // email and a rate limit looked the same and showed the server's own words. Each is a distinct reason now.
  const clientFailing = (error: { status: number; statusText: string; code?: string; message?: string }) => ({
    signIn: {
      email: () => Promise.resolve({ error }),
      magicLink: () => Promise.resolve({ error }),
      social: () => Promise.resolve({ error }),
    },
  });

  it.each([
    [{ status: 401, statusText: 'Unauthorized', message: 'Invalid email or password' }, 'credentials'],
    [{ status: 403, statusText: 'Forbidden', code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }, 'unverified'],
    [{ status: 429, statusText: 'Too Many Requests', message: 'Too many requests' }, 'rateLimited'],
    [{ status: 500, statusText: 'Internal Server Error', message: 'database exploded at db.internal' }, 'unknown'],
  ] as const)('maps %o to the %s reason and drops the server text', async (error, reason) => {
    const handlers = createSignInHandlers(clientFailing(error), { redirectTo: '/', onSignedIn: vi.fn() });
    const refused = await handlers.onPasswordSignIn('a@b.test', 'pw');
    expect(refused).toMatchObject({ code: SignInRefused.code, data: { reason } });
    expect(JSON.stringify(refused)).not.toContain('db.internal');
    expect(await handlers.onMagicLink('a@b.test')).toMatchObject({ data: { reason } });
    expect(await handlers.onSocialSignIn('google')).toMatchObject({ data: { reason } });
  });

  it('signs in only when the call succeeded', async () => {
    const signedIn = vi.fn();
    const ok = { signIn: { email: () => Promise.resolve({ error: null }), social: () => Promise.resolve({ error: null }) } };
    const handlers = createSignInHandlers(ok, { redirectTo: '/', onSignedIn: signedIn });
    expect(await handlers.onPasswordSignIn('a@b.test', 'pw')).toBeUndefined();
    expect(signedIn).toHaveBeenCalledTimes(1);

    const failing = createSignInHandlers(clientFailing({ status: 401, statusText: 'Unauthorized' }), { redirectTo: '/', onSignedIn: signedIn });
    expect(await failing.onPasswordSignIn('a@b.test', 'pw')).toMatchObject({ code: SignInRefused.code });
    expect(signedIn).toHaveBeenCalledTimes(1);
  });

  it('reads the error type of the real engine client, never `any`', () => {
    // WHY: the adapter takes its result type from the engine client. `ReturnType` of the engine's
    // generic method is `any`, which would accept every client and check nothing.
    type EngineError = Awaited<ReturnType<SignInCapableAuthClient['signIn']['email']>>['error'];
    expectTypeOf<EngineError>().not.toBeAny();
    expectTypeOf<NonNullable<EngineError>>().toHaveProperty('status').toEqualTypeOf<number>();
  });
});
