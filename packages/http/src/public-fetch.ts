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
  const transport = options.transport ?? systemTransport;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30000);
  let url = validatePublicURL(value, { allowCredentials: options.allowCredentials });
  let headers = options.headers ?? {};
  if (url.username !== '' || url.password !== '') {
    // The header travels with the other headers: a cross-origin redirect drops it.
    headers = { ...headers, authorization: basicAuthorization(url) };
    url = new URL(url.href);
    url.username = '';
    url.password = '';
  }
  let method = options.method ?? 'GET';
  let body = options.body;
  // Explicit package entry avoids Bun's undici shim, which drops dispatcher options.
  const { Agent } = await import('undici/index.js');
  for (let hop = 0; hop <= 5; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([
      transport.lookup(host),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Fetch timed out.')), { once: true }),
      ),
    ]);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address)))
      throw new Error('Private network addresses are not allowed.');
    const address = addresses[0]!;
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
        if (size > (options.maxBytes ?? 10000000)) {
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
        headers: new Headers(Array.from(response.headers.entries())),
        url: url.href,
      };
    } finally {
      await agent.destroy();
    }
  }
  throw new Error('Feed redirect limit exceeded.');
}
