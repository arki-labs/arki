import { z } from '@arki/contracts';

/**
 * The ports the WHATWG Fetch standard calls bad (https://fetch.spec.whatwg.org/#port-blocking).
 * `fetch` on Node, Deno and browsers refuses a URL on one of them before anything is sent; Bun sends
 * it. Every URL check in this package refuses them, so a setting works the same on every runtime.
 */
export const FETCH_BAD_PORTS = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10_080,
] as const;

const badPorts: ReadonlySet<number> = new Set(FETCH_BAD_PORTS);

/**
 * Whether `fetch` refuses this URL's port on a standard runtime. A URL with no port uses its
 * scheme's default (80 or 443), which is never bad.
 */
export function hasBadPort(url: URL): boolean {
  return url.port !== '' && badPorts.has(Number(url.port));
}

/**
 * An http or https URL `fetch` sends on every runtime: no user name or password (`fetch` throws on
 * those) and no port the Fetch standard blocks (see `FETCH_BAD_PORTS`).
 */
export const fetchUrlSchema = z
  .url({ protocol: /^https?$/ })
  // Zod runs a refinement after a failed format check too, so each one parses only text a URL can be
  .refine(
    url => URL.canParse(url) && new URL(url).username === '' && new URL(url).password === '',
    'must be an http or https URL with no user name or password',
  )
  .refine(
    url => URL.canParse(url) && !hasBadPort(new URL(url)),
    'must not use a port the Fetch standard blocks (such as 6000)',
  );
