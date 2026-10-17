import { redirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { createRequireAuth } from './require-auth.js';

// The guard decides who reaches a protected route: no session must end in the app's own
// sign-in redirect, and a session must pass untouched.
describe('createRequireAuth with a sign-in redirect', () => {
  const redirectToSignIn = redirect({ href: '/auth/sign-in' });
  const signIn = () => redirectToSignIn;

  it('throws the redirect the app built when there is no session', async () => {
    const requireAuth = createRequireAuth(() => Promise.resolve(null), signIn);
    await expect(requireAuth()).rejects.toBe(redirectToSignIn);
  });

  it('lets a signed-in request through', async () => {
    const requireAuth = createRequireAuth(() => Promise.resolve({ user: { id: 'usr_1' } }), signIn);
    await expect(requireAuth()).resolves.toBeUndefined();
  });
});
