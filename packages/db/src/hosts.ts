/**
 * Hosted Postgres poolers, recognised from the URL alone. Behind a pooler in
 * transaction mode a session lasts one transaction, so LISTEN hears nothing and
 * a session advisory lock is held by whoever gets the connection next. Session
 * features therefore need the host's direct URL.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/** The poolers `pooledHostOf` knows. An unknown host counts as direct. */
export const POOLED_HOSTS = ['neon', 'supabase'] as const;

export type PooledHost = (typeof POOLED_HOSTS)[number];

type Pooler = { readonly matches: (url: URL) => boolean; readonly directHint: string };

const poolers = {
  // The pooled endpoint is the direct host with `-pooler` after the endpoint id.
  neon: {
    matches: url => url.hostname.includes('-pooler.'),
    directHint: 'In the Neon console, turn off "Connection pooling" to copy the direct URL.',
  },
  // Supavisor transaction mode listens on 6543. Session mode (5432) keeps the session.
  supabase: {
    matches: url => url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543',
    directHint: 'In the Supabase dashboard, copy the "Direct connection" string, or the session pooler on port 5432.',
  },
} satisfies Record<PooledHost, Pooler>;

/**
 * A session feature was given a pooled URL and no direct one.
 * @fix Set `DB_DIRECT_URL` (or pass `directUrl`) to the host's direct URL.
 * @verify bun run test -- src/hosts.test.ts
 */
export const SessionNeedsDirectUrl = defineFailure('db.session_needs_direct_url', {
  status: 500,
  data: z.object({ host: z.enum(POOLED_HOSTS), hint: z.string() }),
  message: 'LISTEN and session locks need a direct connection, but DB_URL is the {host} pooler.',
  remediation: "Set DB_DIRECT_URL (or pass directUrl) to the host's direct, non-pooled URL.",
});

/** Which known pooler `url` points at, or `undefined` for a direct (or unknown) host. */
export function pooledHostOf(url: string): PooledHost | undefined {
  const parsed = URL.parse(url);
  if (parsed === null) return undefined;
  return POOLED_HOSTS.find(host => poolers[host].matches(parsed));
}

/**
 * The URL for session features: LISTEN, session advisory locks, migrations.
 * `directUrl` when given; else `url`, unless `url` is a known pooler.
 */
export function resolveDirectUrl(urls: { readonly url: string; readonly directUrl?: string | undefined }) {
  if (urls.directUrl !== undefined && urls.directUrl !== '') return urls.directUrl;
  const host = pooledHostOf(urls.url);
  return host === undefined ? urls.url : SessionNeedsDirectUrl({ host, hint: poolers[host].directHint });
}
