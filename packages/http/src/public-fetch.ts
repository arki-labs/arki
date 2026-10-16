import ipaddr from 'ipaddr.js';
import type { fetch as undiciFetch } from 'undici/index.js';

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
 * it as a Basic `Authorization` header). Errors never carry the URL itself.
 */
export function validatePublicURL(value: string, options: { allowCredentials?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid URL.');
  }
  const hasCredentials = url.username !== '' || url.password !== '';
  if (!['http:', 'https:'].includes(url.protocol) || (hasCredentials && !options.allowCredentials))
    throw new Error('Only public HTTP feeds are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new Error('Private network addresses are not allowed.');
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
 * redirect only to another public URL. The body is read here, under `maxBytes`, because the pinned
 * connection is closed before this returns.
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
    if (address === undefined || addresses.some(a => !isPublicAddress(a.address)))
      throw new Error('Private network addresses are not allowed.');
    // Resolve once and pin the connection; a second DNS answer must never select a private address.
    const agent = new Agent({
      connect: {
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
    });
    try {
      const response = await transport.fetch(url, { dispatcher: agent, method, body, headers, redirect: 'manual', signal });
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

/** Statuses whose response must have no body; `new Response(bytes, { status })` throws for them. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A `fetch` that reaches public addresses only, for server code that calls URLs it does not fully
 * control: `createClient(contracts, { baseUrl, fetch: publicFetch() })`. Each hop is resolved,
 * checked and pinned, as in {@link safeFetchBytes}; a private address or a redirect to one rejects.
 *
 * The response is buffered (at most `maxBytes`, default 10 MB) before it is returned, so a
 * streaming body arrives whole. Credentials in the URL are refused; send them as a header.
 */
export function publicFetch(options: { maxBytes?: number; transport?: PublicFetchTransport } = {}) {
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
      signal: init.signal ?? undefined,
      maxBytes: options.maxBytes ?? 10_000_000,
      transport: options.transport ?? systemTransport,
    });
    return new Response(NULL_BODY_STATUSES.has(result.status) ? null : result.bytes, {
      status: result.status,
      headers: result.headers,
    });
  };
}
