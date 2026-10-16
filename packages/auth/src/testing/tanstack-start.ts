/**
 * `@arki/auth/testing/tanstack-start` — a POST route that hands Playwright a signed-in session.
 *
 * It is absent unless `enabled` is `true` (pass it from an explicit test-mode flag, never from
 * `NODE_ENV`), acts only on reserved test addresses, and refuses malformed bodies. The session is
 * made by `auth.testing`, which itself refuses in production, so a deployed backend cannot mint
 * sessions even if the route is mounted by mistake.
 */
import { isAuthError } from '../errors.js';
import { log } from '../log.js';

/** What the route needs from an auth: test sign-in by email (every `Auth` has it). */
export type E2EAuth = {
  readonly testing: {
    readonly signIn: (
      user: { readonly email: string },
      options?: { readonly password?: string },
    ) => Promise<{ readonly headers: Headers }>;
  };
};

export type CreateE2EHandlerOptions = {
  readonly auth: E2EAuth;
  /** `true` only in an explicit test mode. Default `false`: every request answers 404. */
  readonly enabled?: boolean;
  /** The address used when the body names none. */
  readonly defaultEmail: string;
  /**
   * Addresses this route may sign in. Default: only the reserved `.test` top-level domain
   * (RFC 2606), so a real person's account can never be reached.
   */
  readonly allowEmail?: (email: string) => boolean;
  /**
   * When set, the signed-in user's password becomes this one, so form-driven specs can sign in
   * with it too. Needs the `password` method.
   */
  readonly password?: string;
};

const isReservedTestAddress = (email: string): boolean => /^[^\s@]+@[^\s@]+\.test$/i.test(email);

/** The requested address: the body's `email`, else the default. Anything else is malformed. */
async function emailOf(request: Request, defaultEmail: string): Promise<string | undefined> {
  const text = await request.text();
  if (text.trim() === '') return defaultEmail;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const email: unknown = Reflect.get(body, 'email');
  if (email === undefined) return defaultEmail;
  return typeof email === 'string' && email !== '' ? email : undefined;
}

export function createE2EHandler(options: CreateE2EHandlerOptions) {
  const { auth, enabled = false, defaultEmail, allowEmail = isReservedTestAddress, password } = options;
  return async ({ request }: { readonly request: Request }): Promise<Response> => {
    if (!enabled) return new Response(null, { status: 404 });
    const email = await emailOf(request, defaultEmail);
    if (email === undefined) {
      return Response.json({ error: 'The body must be empty or { "email": string }.' }, { status: 400 });
    }
    if (!allowEmail(email)) {
      log.warn('Refused an e2e session for an address outside the test addresses');
      return Response.json({ error: 'This address cannot be used for test sessions.' }, { status: 403 });
    }
    try {
      const { headers } = await auth.testing.signIn({ email }, password === undefined ? {} : { password });
      const cookie = headers.get('cookie') ?? '';
      return Response.json(
        { email },
        { status: 200, headers: { 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax` } },
      );
    } catch (error) {
      if (isAuthError(error)) return Response.json({ code: error.code }, { status: 404 });
      throw error;
    }
  };
}
