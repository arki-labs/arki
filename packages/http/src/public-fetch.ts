import type { fetch as undiciFetch } from 'undici/index.js';
import ipaddr from 'ipaddr.js';

import { UnsafeUrlError } from './error.js';

export { UnsafeUrlError } from './error.js';

/**
 * The two network calls a public fetch makes. Production uses the system
 * resolver and undici; a test passes fakes here and every address check
 * (literal IP, DNS answer, each redirect hop) still runs for real.
 */
export type PublicFetchTransport = {
  lookup: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  fetch: typeof undiciFetch;
};

/**
 * The system resolver and undici, loaded on first use: this module's top
 * level has no `node:` import, so the pure checks (`validatePublicURL`) also
 * load in a browser bundle that shares a schema with the server.
 */
export const systemTransport: PublicFetchTransport = {
  lookup: async hostname => {
    const dns = await import('node:dns/promises');
    return dns.lookup(hostname, { all: true });
  },
  fetch: async (input, init) => {
    const undici = await import('undici/index.js');
    return undici.fetch(input, init);
  },
};

/** The env variable that lists hosts the guard lets through even at a private address (tests only). */
export const FETCH_ALLOW_HOSTS_ENV = 'FETCH_ALLOW_HOSTS';

/**
 * Hosts (`host:port`, comma separated, from `FETCH_ALLOW_HOSTS`) that skip the private-address
 * checks. It exists so an end-to-end test can fetch from a feed server on the same machine. It
 * throws in production, so a misset variable can never open the guard; call it at boot to fail early.
 * Only the exact `host:port` listed is allowed; every other private address is still refused.
 */
export function fetchAllowedHosts(
  env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined' ? {} : process.env,
): ReadonlySet<string> {
  const listed = (env[FETCH_ALLOW_HOSTS_ENV] ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(host => host !== '');
  if (listed.length > 0 && env['NODE_ENV'] === 'production')
    throw new Error(`${FETCH_ALLOW_HOSTS_ENV} is for tests only; refusing to run in production.`);
  return new Set(listed);
}

function isAllowedHost(url: URL) {
  return fetchAllowedHosts().has(url.host.toLowerCase());
}

export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
/**
 * The URL must be http(s) at a public address. `user:pass@` is refused unless
 * `allowCredentials` is set (private feeds use it; `safeFetchBytes` then sends
 * it as a Basic `Authorization` header). A refusal throws {@link UnsafeUrlError}, whose message
 * never carries the URL itself.
 */
export function validatePublicURL(value: string, options: { allowCredentials?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError('Invalid URL.');
  }
  const hasCredentials = url.username !== '' || url.password !== '';
  if (!['http:', 'https:'].includes(url.protocol) || (hasCredentials && !options.allowCredentials))
    throw new UnsafeUrlError('Only public HTTP feeds are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host) && !isAllowedHost(url))
    throw new UnsafeUrlError('Private network addresses are not allowed.');
  return url;
}

/** `user:pass@` from a URL as a Basic `Authorization` value (UTF-8, percent-decoding undone). */
function basicAuthorization(url: URL): string {
  const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return `Basic ${btoa(String.fromCodePoint(...new TextEncoder().encode(pair)))}`;
}
/** One request through the guard: the URL is already checked and carries no credentials. */
type PinnedRequest = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array<ArrayBuffer> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly maxBytes: number;
  readonly transport: PublicFetchTransport;
};

/** Rejects once `signal` aborts (at once when it already has), with its reason when that is an error. */
function untilAborted(signal: AbortSignal): Promise<never> {
  const reason = (): Error => (signal.reason instanceof Error ? signal.reason : new Error('Fetch aborted.'));
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(reason());
    else signal.addEventListener('abort', () => reject(reason()), { once: true });
  });
}

/**
 * The guard itself, shared by {@link safeFetchBytes} and {@link publicFetch}: every hop resolves
 * the host, refuses any private answer, pins the connection to the checked address, and follows a
 * redirect only to another public URL; each refusal throws {@link UnsafeUrlError}. The body is
 * read here, under `maxBytes`, because the pinned connection is closed before this returns.
 */
async function fetchPinned(request: PinnedRequest) {
  const { transport, signal, maxBytes } = request;
  let { url, method, headers, body } = request;
  // Explicit package entry avoids Bun's undici shim, which drops dispatcher options.
  const { Agent } = await import('undici/index.js');
  for (let hop = 0; hop <= 5; hop++) {
    const host = url.hostname.replaceAll(/^\[|\]$/g, '');
    const addresses = await (signal === undefined
      ? transport.lookup(host)
      : Promise.race([transport.lookup(host), untilAborted(signal)]));
    const [address] = addresses;
    if (address === undefined || (!addresses.every(a => isPublicAddress(a.address)) && !isAllowedHost(url)))
      throw new UnsafeUrlError('Private network addresses are not allowed.');
    // Resolve once and pin the connection; a second DNS answer must never select a private address.
    const agent = new Agent({
      connect: {
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
    });
    try {
      const response = await transport.fetch(url, {
        dispatcher: agent,
        method,
        body,
        headers,
        redirect: 'manual',
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === 5) throw new Error('Feed redirect limit exceeded.');
        const next = validatePublicURL(new URL(location, url).href);
        if (next.origin !== url.origin) headers = {};
        // Like a browser: 301/302/303 turn a POST into a GET and drop its body; 307/308 replay it.
        if ([301, 302, 303].includes(response.status) && method !== 'GET' && method !== 'HEAD') {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) {
          throw new Error('Response size limit exceeded.');
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        bytes,
        status: response.status,
        headers: new Headers([...response.headers.entries()]),
        url: url.href,
      };
    } finally {
      await agent.destroy();
    }
  }
  throw new Error('Feed redirect limit exceeded.');
}

export async function safeFetchBytes(
  value: string,
  options: {
    maxBytes?: number;
    headers?: Record<string, string>;
    timeoutMs?: number;
    method?: string;
    body?: string;
    /** Accept `user:pass@` in `value`; it is stripped from the request URL and sent as a Basic `Authorization` header. */
    allowCredentials?: boolean;
    transport?: PublicFetchTransport;
  } = {},
) {
  let url = validatePublicURL(value, { allowCredentials: options.allowCredentials });
  let headers = options.headers ?? {};
  if (url.username !== '' || url.password !== '') {
    // The header travels with the other headers: a cross-origin redirect drops it.
    headers = { ...headers, authorization: basicAuthorization(url) };
    url = new URL(url.href);
    url.username = '';
    url.password = '';
  }
  return fetchPinned({
    url,
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    maxBytes: options.maxBytes ?? 10_000_000,
    transport: options.transport ?? systemTransport,
  });
}

/** The caller's signal, if any, bounded by a timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Statuses whose response must have no body; `new Response(bytes, { status })` throws for them. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A `fetch` that reaches public addresses only, for server code that calls URLs it does not fully
 * control: `createClient(contracts, { baseUrl, fetch: publicFetch() })`. Each hop is resolved,
 * checked and pinned, as in {@link safeFetchBytes}; a private address or a redirect to one rejects.
 *
 * The response is buffered (at most `maxBytes`, default 10 MB) before it is returned, so a
 * streaming body arrives whole. Every request, body included, must finish within `timeoutMs`
 * (default 30 s), so a slow server cannot hold a connection open. Credentials in the URL are
 * refused; send them as a header.
 */
export function publicFetch(options: { maxBytes?: number; timeoutMs?: number; transport?: PublicFetchTransport } = {}) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const body =
      init.body === undefined || init.body === null || typeof init.body === 'string'
        ? (init.body ?? undefined)
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    const result = await fetchPinned({
      url: validatePublicURL(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers)),
      body,
      signal: withTimeout(init.signal ?? undefined, options.timeoutMs ?? 30_000),
      maxBytes: options.maxBytes ?? 10_000_000,
      transport: options.transport ?? systemTransport,
    });
    return new Response(NULL_BODY_STATUSES.has(result.status) ? null : result.bytes, {
      status: result.status,
      headers: result.headers,
    });
  };
}
