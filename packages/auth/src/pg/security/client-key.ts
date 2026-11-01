/**
 * The key the engine's rate limiter counts a request on, when the app names no
 * `runtime().clientIp.header` (no `clientIp`, or `clientIp: { from: 'socket' }`).
 *
 * The engine reads that key from one request header and accepts only an IP address there. This
 * package owns that header ({@link CLIENT_KEY_HEADER}): it drops any value a caller sent, so no
 * request header (`x-forwarded-for` included) can pick a bucket. It then writes, in order:
 *
 * 1. the socket address the runtime puts on the request (`request.ip`, set by srvx under
 *    TanStack Start, Nitro and h3);
 * 2. else the target account: the signed-in user's id, else the body `email` on the endpoints
 *    whose account IS that email ({@link EMAIL_ACCOUNT_PATHS}). A shared key here would let one
 *    client lock every user out of sign-in. Any other body email is ignored: on other endpoints
 *    a fresh email per request would buy a fresh budget;
 * 3. else nothing, and every caller shares one key. Production never gets here: it needs
 *    `clientIp` (`ARKI_AUTH_E009`), and `{ from: 'socket' }` refuses a request without a socket
 *    address (`ARKI_AUTH_E010`).
 *
 * DELIBERATE WORKAROUND (founder decision, 2026-11-01): an account becomes an IP address. The
 * engine accepts only an IP address as the rate-limit key, and a second limiter next to it would
 * copy its rules (paths, windows, plugin rules). The address is a private IPv6 (`fd00::/8`,
 * RFC 4193) whose first 64 bits come from a SHA-256 of the account, because the engine keeps only
 * the /64 of an IPv6 address. {@link CLIENT_KEY_KIND_HEADER} marks it, so a session never records
 * it as the client's address.
 */
import { is, recordSchema } from '@arki/schema';
import { z } from 'zod';

/** The one header the engine reads the client key from when no `clientIp.header` is configured. */
export const CLIENT_KEY_HEADER = 'x-arki-auth-client-key';

/** Set to `account` when {@link CLIENT_KEY_HEADER} holds an account key, not a client address. */
export const CLIENT_KEY_KIND_HEADER = 'x-arki-auth-client-key-kind';

/**
 * The endpoints whose account is the body `email`: sign-in with a password, the password-reset
 * request, magic-link sign-in. The engine here has no email-OTP endpoints. Every other endpoint
 * ignores the body email for the rate-limit key.
 */
export const EMAIL_ACCOUNT_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/request-password-reset',
  '/sign-in/magic-link',
]);

const socketAddressSchema = z.string().min(1);

/** The runtime check of `runtime().clientIp` (`ClientIpSource` is the source type): a header or the socket, never both. */
export const clientIpSchema = z.union([
  z.strictObject({ header: z.string().min(1), from: z.undefined().optional() }).readonly(),
  z.strictObject({ from: z.literal('socket'), header: z.undefined().optional() }).readonly(),
]);
const emailBodySchema = z.object({ email: z.string().trim().min(1) });

/** The socket address the runtime put on the request, if any. */
export function socketAddressOf(request: Request): string | undefined {
  const ip: unknown = Reflect.get(request, 'ip');
  return is(ip, socketAddressSchema) ? ip : undefined;
}

/** The private IPv6 address that stands for an account in the engine's rate-limit key. */
export async function accountKeyAddress(account: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)));
  const hex = (index: number) => (digest[index] ?? 0).toString(16).padStart(2, '0');
  return `fd${hex(0)}:${hex(1)}${hex(2)}:${hex(3)}${hex(4)}:${hex(5)}${hex(6)}::`;
}

/** Copies `headers` without the two client-key headers, whatever a caller put there. */
export function withoutClientKey(headers: Headers): Headers {
  const result = new Headers(headers);
  result.delete(CLIENT_KEY_HEADER);
  result.delete(CLIENT_KEY_KIND_HEADER);
  return result;
}

/** The `email` of a JSON body, lowercased, or `undefined`. */
function emailOf(body: ArrayBuffer | null, contentType: string | null): string | undefined {
  if (body === null || !(contentType ?? '').includes('application/json')) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  return is(json, recordSchema) && is(json, emailBodySchema) ? json.email.toLowerCase() : undefined;
}

/**
 * The account a request targets: the signed-in user, else the body `email` on an
 * {@link EMAIL_ACCOUNT_PATHS} endpoint. The session wins over any body field, which the caller
 * picks freely.
 */
async function accountOf(
  path: string,
  body: ArrayBuffer | null,
  headers: Headers,
  userIdOf: ClientKeyInput['userIdOf'],
): Promise<string | undefined> {
  if (headers.has('cookie') || headers.has('authorization')) {
    const userId = await userIdOf(headers);
    if (userId !== undefined) return `user:${userId}`;
  }
  if (!EMAIL_ACCOUNT_PATHS.has(path.replace(/\/+$/, ''))) return undefined;
  const email = emailOf(body, headers.get('content-type'));
  return email === undefined ? undefined : `email:${email}`;
}

/** A request without the client-key headers a caller sent; the same request when it sent none. */
export async function withoutCallerClientKey(request: Request): Promise<Request> {
  if (!request.headers.has(CLIENT_KEY_HEADER) && !request.headers.has(CLIENT_KEY_KIND_HEADER)) return request;
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  const headers = withoutClientKey(request.headers);
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}

/** What the handler needs to key a request: its engine path and the signed-in user, if any. */
export type ClientKeyInput = {
  readonly path: string;
  /** The signed-in user's id; called only when the request carries a credential. */
  readonly userIdOf: (headers: Headers) => Promise<string | undefined>;
};

/**
 * The request the engine sees when no `clientIp.header` is configured, with its client key set as
 * described at the top of this file. The caller checks first that a required socket address is
 * there ({@link socketAddressOf}).
 */
export async function withClientKey(request: Request, { path, userIdOf }: ClientKeyInput): Promise<Request> {
  const headers = withoutClientKey(request.headers);
  // Field by field, not `new Request(request, ...)`: a runtime's own request class (srvx on Node)
  // is not a native `Request`. Auth bodies are small JSON, so the body is read whole.
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();

  const address = socketAddressOf(request);
  if (address === undefined) {
    const account = await accountOf(path, body, headers, userIdOf);
    if (account !== undefined) {
      headers.set(CLIENT_KEY_HEADER, await accountKeyAddress(account));
      headers.set(CLIENT_KEY_KIND_HEADER, 'account');
    }
  } else {
    headers.set(CLIENT_KEY_HEADER, address);
  }
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}
