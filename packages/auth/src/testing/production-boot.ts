/**
 * Production-boot checks for app test suites (the C1 regression class: a sign-in method that
 * silently disappears in production). `assertAuthBoots` boots an app's auth module under
 * `NODE_ENV=production` and checks that every method the definition declares is live in the
 * engine. `applyProductionBootEnv` is the env flip it uses, and `emailModuleMock` is the
 * `@arki/mail` mock an app wires through vitest's hoisted `vi.mock`: `vi.mock(...)` is hoisted to
 * the top of the consuming file, so it cannot be authored here.
 */
import { expect, vi } from 'vitest';

import type * as MailModule from '@arki/mail';

import type { AuthDefinition } from '../definition.js';
import type { AuthEngine } from '../pg/engine.js';
import { isSocialMethod } from '../definition.js';

const MUTATED_ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'DB_URL',
  'AUTH_SECRET',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_EMAIL_API_TOKEN',
] as const;

/**
 * Prepare process.env so a dynamic auth-module import evaluates as a production
 * boot, and return a restore function that undoes exactly the keys this touched
 * (so NODE_ENV=production never leaks into sibling tests in the same worker).
 * - Flips NODE_ENV to 'production' so the factory's auto-enable branch
 *   (`NODE_ENV !== 'production'`) does NOT fire.
 * - Bridges DB_URL → DATABASE_URL (`@arki/testing` global setup sets DB_URL; app
 *   env schemas read DATABASE_URL — only strict production validation exposes it).
 * - Stubs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN so app env
 *   schemas that require them at import validate (avocabo, D-ING-021). The
 *   former RESEND_API_KEY stub was removed 2026-07-13 — no app env requires
 *   it anymore.
 * - Stubs DB_URL + AUTH_SECRET for apps WITHOUT a testcontainer (D-09). Flipping to
 *   production re-enables strict `@arki/db/env` (DB_URL) + `@arki/auth/env`
 *   (AUTH_SECRET) validation that `NODE_ENV==='test'` was skipping; testcontainer
 *   apps (novelette) set a real DB_URL that wins via `??=`. The fake DB_URL never
 *   dials — pg-pool connects lazily on first query, and booting auth runs none.
 *
 * Restoring env AFTER the dynamic import is safe: the auth module is constructed
 * (and its `options` captured) at first import, then module-cached, so a later
 * env restore cannot mutate the already-built instance.
 */
export function applyProductionBootEnv(): () => void {
  const previous = new Map(MUTATED_ENV_KEYS.map(key => [key, process.env[key]]));
  if (!process.env.DATABASE_URL && process.env.DB_URL) {
    process.env.DATABASE_URL = process.env.DB_URL;
  }
  process.env.NODE_ENV = 'production';
  process.env.CLOUDFLARE_ACCOUNT_ID ??= 'test-cf-account-id';
  process.env.CLOUDFLARE_EMAIL_API_TOKEN ??= 'test-cf-email-token';
  process.env.DB_URL ??= 'postgres://user:pass@localhost:5432/prod_boot_test';
  process.env.AUTH_SECRET ??= 'prod-boot-test-secret-at-least-32-characters-long';
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The `@arki/mail` module mock: the real module, except that every `mailer()`
 * sends through a `mailSink()` — nothing leaves the process. Consumers wire it
 * through vitest's hoisted `vi.mock`, delegating here to keep the body DRY:
 *
 * ```ts
 * vi.mock('@arki/mail', async () => {
 *   const { emailModuleMock } = await import('@arki/auth/testing/production-boot');
 *   return emailModuleMock();
 * });
 * ```
 */
export async function emailModuleMock(): Promise<typeof MailModule> {
  const actual = await vi.importActual<typeof MailModule>('@arki/mail');
  const { mailSink } = await import('@arki/mail/testing');
  return { ...actual, mailer: options => actual.mailer({ ...options, transport: mailSink() }) };
}

/** What `assertAuthBoots` reads: the definition and the engine it was built into. */
export type BootableAuth = {
  readonly definition: AuthDefinition;
  readonly engine: AuthEngine;
};

/**
 * Boots an app's auth module as production and asserts the engine serves exactly what the
 * definition declares: every method enabled (the C1 bug class: a method that silently is not),
 * rate limiting on, secure cookies. It reads the built options and sends no request, so no
 * database, KV or mail is needed.
 *
 * @param importAuth dynamic importer of the module that builds the auth, e.g.
 *   `() => import('../../infra/auth')`. Dynamic, so the production env is in place first.
 */
export async function assertAuthBoots<A extends BootableAuth>(
  importAuth: () => Promise<{ readonly auth: A }>,
): Promise<A> {
  const restoreEnv = applyProductionBootEnv();
  try {
    const { auth } = await importAuth();
    const { options } = auth.engine;
    const { methods } = auth.definition;
    expect(options.emailAndPassword?.enabled ?? false, 'password sign-in').toBe(methods.includes('password'));
    expect(options.plugins?.some(entry => entry.id === 'magic-link') ?? false, 'magic link').toBe(
      methods.includes('magicLink'),
    );
    expect(new Set(Object.keys(options.socialProviders ?? {})), 'social providers').toEqual(
      new Set(methods.filter(method => isSocialMethod(method))),
    );
    expect(options.rateLimit?.enabled, 'rate limiting').toBe(true);
    expect(options.advanced?.useSecureCookies, 'secure cookies').toBe(true);
    return auth;
  } finally {
    restoreEnv();
  }
}
