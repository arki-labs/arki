/**
 * Pooler detection decides whether LISTEN and session locks may use `DB_URL`.
 * A miss means a listener that silently hears nothing; a false hit blocks a
 * direct database. Each case pins one side of that line.
 */
import { isFailure } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import { pooledHostOf, resolveDirectUrl, SessionNeedsDirectUrl } from './hosts.js';

const neonPooled = 'postgresql://app:pw@ep-cool-darkness-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const neonDirect = 'postgresql://app:pw@ep-cool-darkness-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const supabaseTransaction = 'postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
const supabaseSession = 'postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

describe('pooledHostOf', () => {
  it('knows the Neon pooled endpoint, and not the direct one', () => {
    expect(pooledHostOf(neonPooled)).toBe('neon');
    expect(pooledHostOf(neonDirect)).toBeUndefined();
  });

  it('flags Supabase transaction mode only: session mode on 5432 keeps LISTEN working', () => {
    expect(pooledHostOf(supabaseTransaction)).toBe('supabase');
    expect(pooledHostOf(supabaseSession)).toBeUndefined();
  });

  it('treats plain and unknown hosts as direct, so self-hosted Postgres is never blocked', () => {
    expect(pooledHostOf('postgresql://user:pw@localhost:5432/app')).toBeUndefined();
    expect(pooledHostOf('postgresql://user:pw@db.abc.eu-west-1.rds.amazonaws.com:5432/app')).toBeUndefined();
    expect(pooledHostOf('not a url')).toBeUndefined();
  });
});

describe('resolveDirectUrl', () => {
  it('uses directUrl even when url is pooled: the app said where the session lives', () => {
    expect(resolveDirectUrl({ url: neonPooled, directUrl: neonDirect })).toBe(neonDirect);
  });

  it('uses url itself when it is direct, so one URL is enough for plain Postgres', () => {
    expect(resolveDirectUrl({ url: neonDirect })).toBe(neonDirect);
    expect(resolveDirectUrl({ url: neonDirect, directUrl: '' })).toBe(neonDirect);
  });

  it('refuses a pooled url with no directUrl, naming the host and how to find its direct URL', () => {
    const outcome = resolveDirectUrl({ url: supabaseTransaction });
    if (!isFailure(outcome)) throw new Error('expected a failure');
    expect(SessionNeedsDirectUrl.is(outcome)).toBe(true);
    expect(outcome.message).toContain('supabase pooler');
    expect(outcome.data.hint).toContain('Direct connection');
  });
});
