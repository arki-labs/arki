import { createLogger } from '@arki/log';

const log = createLogger('arki:auth:e2e');

type InternalAdapter = {
  findUserByEmail: (
    email: string,
    options?: { includeAccounts: boolean } | undefined,
  ) => Promise<{ user: { id: string } } | null>;
  deleteUser: (userId: string) => Promise<void>;
};

type AuthContextLike = {
  baseURL: string;
  options: { basePath?: string } & Record<string, unknown>;
  internalAdapter: InternalAdapter;
};

type AuthLike = {
  handler: (request: Request) => Promise<Response>;
  $context: Promise<AuthContextLike> | AuthContextLike;
};

export type CreateE2EHandlerOptions = {
  /**
   * Live `auth` instance returned by `defineAuthBackend` (or `betterAuth`).
   * The handler routes requests through `auth.handler(...)` so the official
   * `tanstackStartCookies` plugin writes signed `Set-Cookie` headers for us —
   * no manual HMAC, no custom signing.
   */
  auth: AuthLike;
  /** Default email if the request body omits one. */
  defaultEmail: string;
  /**
   * Password used to seed the test user. Same value drives both the
   * sign-up and sign-in calls. Default `'e2e-test-password-1234'`.
   */
  testPassword?: string;
  /** Display name for the test user (visible on the profile). */
  testUserName?: string;
};

type CreateSessionBody = { email?: string };

const DEFAULT_TEST_PASSWORD = 'e2e-test-password-1234';
const DEFAULT_TEST_USER_NAME = 'E2E Test User';

async function postAuth(auth: AuthLike, path: string, body: unknown, headers?: Headers): Promise<Response> {
  const ctx = await Promise.resolve(auth.$context);
  // better-auth mounts its routes at `${baseURL}${basePath ?? '/api/auth'}/...`.
  // The base URL is the app origin (no path prefix); the basePath is the auth
  // API mount point (default `/api/auth`). We have to combine them ourselves.
  const basePath = ctx.options.basePath ?? '/api/auth';
  const origin = new URL(ctx.baseURL).origin;
  const url = new URL(`${basePath.replace(/\/$/, '')}${path}`, origin);
  const requestHeaders = new Headers(headers ?? {});
  requestHeaders.set('content-type', 'application/json');
  return auth.handler(
    new Request(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    }),
  );
}

function mergeSetCookies(target: Headers, source: Headers): void {
  const setCookies = source.getSetCookie?.() ?? [];
  if (setCookies.length === 0) {
    const single = source.get('set-cookie');
    if (single) target.append('set-cookie', single);
    return;
  }
  for (const cookie of setCookies) target.append('set-cookie', cookie);
}

/**
 * Builds a test-only POST handler that seeds a session for Playwright.
 *
 * Refuses in production (`NODE_ENV === 'production'` returns 404). In dev/test
 * mode it idempotently signs the test user up via the official
 * `/api/auth/sign-up/email` route, then signs them back in via
 * `/api/auth/sign-in/email`. Better-auth's `tanstackStartCookies` plugin
 * attaches the signed session cookie to the response automatically.
 *
 * The shared factory `defineAuthBackend` enables `emailAndPassword` by default
 * in non-production environments precisely so this handler works without any
 * per-app opt-in.
 */
export function createE2EHandler({
  auth,
  defaultEmail,
  testPassword = DEFAULT_TEST_PASSWORD,
  testUserName = DEFAULT_TEST_USER_NAME,
}: CreateE2EHandlerOptions) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    if (process.env['NODE_ENV'] === 'production') {
      return new Response(null, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as CreateSessionBody;
    const email = typeof body.email === 'string' && body.email.length > 0 ? body.email : defaultEmail;

    // Idempotency: nuke any prior test user so we can guarantee a fresh
    // credential account. Test runs from before this handler existed may have
    // left a user row without a matching `credential` account row, which would
    // make sign-in fail with INVALID_EMAIL_OR_PASSWORD on every run.
    const ctx = await Promise.resolve(auth.$context);
    const existing = await ctx.internalAdapter.findUserByEmail(email).catch(() => null);
    if (existing?.user?.id) {
      await ctx.internalAdapter.deleteUser(existing.user.id).catch((err: unknown) => {
        log.warn('failed to delete prior e2e user', { email, error: String(err) });
      });
    }

    const signUpResponse = await postAuth(auth, '/sign-up/email', {
      email,
      password: testPassword,
      name: testUserName,
    });

    if (!signUpResponse.ok) {
      const text = await signUpResponse.text().catch(() => '');
      log.error('e2e sign-up failed', { status: signUpResponse.status, body: text });
    }

    const signInResponse = await postAuth(auth, '/sign-in/email', {
      email,
      password: testPassword,
    });

    if (!signInResponse.ok) {
      const text = await signInResponse.text().catch(() => '');
      return new Response(text || 'e2e sign-in failed', {
        status: signInResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    const responseHeaders = new Headers({ 'content-type': 'application/json' });
    mergeSetCookies(responseHeaders, signInResponse.headers);

    const payload = (await signInResponse.json().catch(() => ({}))) as Record<string, unknown>;
    return new Response(JSON.stringify({ email, ...payload }), {
      status: 200,
      headers: responseHeaders,
    });
  };
}
