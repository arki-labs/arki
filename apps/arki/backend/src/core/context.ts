import { db, repositories } from '../db';
import { kv } from '../kv';
import type { Auth } from './auth/config';

/**
 * Creates the oRPC context for each incoming request.
 * Provides access to the database, principal, repositories, and other services.
 */
export const createRPCContext = async (opts: { headers: Headers; auth: Auth }) => {
  const principal = await opts.auth.principal(opts.headers);

  const source = opts.headers.get('x-rpc-source') ?? 'unknown';
  const ip =
    opts.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    opts.headers.get('x-real-ip') ??
    'unknown';

  console.log(`[oRPC] Request from ${source} by ${principal?.user.email ?? 'anonymous'} (ip: ${ip})`);

  return {
    db,
    ip,
    /** `null` for a guest: who is calling (user row, session, roles). */
    principal,
    user: principal?.user,
    runInTransaction: db.transaction.bind(db),
    repo: repositories,
    kv,
  };
};

export type ORPCContext = Awaited<ReturnType<typeof createRPCContext>>;
