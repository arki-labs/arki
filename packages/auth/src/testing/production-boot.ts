/**
 * Shared production-boot assertion for the C1 regression (workspace feature
 * cross-app-auth-prod-fix, D-03). `defineAuthBackend` only auto-enables
 * email/password when NODE_ENV !== 'production'; an app that forgets an explicit
 * `emailAndPassword` block silently loses credential auth in production. This
 * helper boots an app's auth module under NODE_ENV=production and asserts the
 * email/password feature RESOLVED as enabled.
 *
 * Why not assert `auth.api.signUpEmail` is defined (D-08): better-auth always
 * materializes that endpoint; it throws at request time when disabled. The
 * faithful check is `auth.options.emailAndPassword?.enabled === true` — the same
 * flag the endpoint gates on (better-auth `api/routes/sign-up.mjs:144`).
 *
 * Shape rationale (vitest hoisting): `vi.mock(...)` is hoisted to the top of the
 * *consuming* file and cannot be authored here, so the email mock is exposed as
 * `emailModuleMock` for the consumer to wire. The NODE_ENV flip does NOT need
 * hoisting — every consumer imports its auth module DYNAMICALLY, so flipping env
 * synchronously right before that import (inside `assertEmailPasswordEnabled`)
 * is sufficient.
 */
import { expect, vi } from 'vitest';

import type { DefinedAuth } from '../define-auth-backend';

const MUTATED_ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'RESEND_API_KEY'] as const;

/**
 * Prepare process.env so a dynamic auth-module import evaluates as a production
 * boot, and return a restore function that undoes exactly the keys this touched
 * (so NODE_ENV=production never leaks into sibling tests in the same worker).
 * - Flips NODE_ENV to 'production' so the factory's auto-enable branch
 *   (`NODE_ENV !== 'production'`) does NOT fire.
 * - Bridges DB_URL → DATABASE_URL (`@arki/testing` global setup sets DB_URL; app
 *   env schemas read DATABASE_URL — only strict production validation exposes it).
 * - Stubs RESEND_API_KEY so app env schemas that require it at import validate.
 *
 * Restoring env AFTER the dynamic import is safe: the auth module is constructed
 * (and its `options` captured) at first import, then module-cached, so a later
 * env restore cannot mutate the already-built instance.
 */
export function applyProductionBootEnv(): () => void {
  const previous = new Map(MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  if (!process.env.DATABASE_URL && process.env.DB_URL) {
    process.env.DATABASE_URL = process.env.DB_URL;
  }
  process.env.NODE_ENV = 'production';
  process.env.RESEND_API_KEY ??= 'test_resend_key';
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The `@arki/emails` module mock. Consumers wire it through vitest's hoisted
 * `vi.mock`, delegating here to keep the body DRY:
 *
 * ```ts
 * vi.mock('@arki/emails', async () => {
 *   const { emailModuleMock } = await import('@arki/auth/testing/production-boot');
 *   return emailModuleMock();
 * });
 * ```
 */
export function emailModuleMock(): {
  createEmailClientFromEnv: () => { send: ReturnType<typeof vi.fn> };
} {
  return {
    createEmailClientFromEnv: () => ({
      send: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
}

/**
 * Boot an app's auth module in production mode and assert email/password
 * RESOLVED as enabled. Throws (fails the test) when it didn't — the exact C1
 * bug (missing explicit `emailAndPassword` block ⇒ not auto-enabled in prod).
 *
 * @param importAuth dynamic importer for the app's auth module, e.g.
 *   `() => import('../../../core/auth')`. MUST be dynamic so the env flip lands
 *   before the module's top-level `defineAuthBackend` call evaluates.
 */
export async function assertEmailPasswordEnabled(
  importAuth: () => Promise<{ auth: DefinedAuth }>,
): Promise<DefinedAuth> {
  const restoreEnv = applyProductionBootEnv();
  try {
    const { auth } = await importAuth();
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    return auth;
  } finally {
    restoreEnv();
  }
}
