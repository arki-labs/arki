import { db, repositories } from '../db';
import type { UserModel } from '../features/auth';
import { kv } from '../kv';
import { eventStore } from '../store';
import type { Auth } from './auth/config';

/**
 * Creates the oRPC context for each incoming request.
 * Provides access to the database, session, repositories, and other services.
 */
export const createRPCContext = async (opts: { headers: Headers; auth: Auth }) => {
  const authApi = opts.auth.api;
  const session = await authApi.getSession({
    headers: opts.headers,
  });

  const source = opts.headers.get('x-rpc-source') ?? 'unknown';
  const ip =
    opts.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    opts.headers.get('x-real-ip') ??
    'unknown';

  console.log(`[oRPC] Request from ${source} by ${session?.user?.email ?? 'anonymous'} (ip: ${ip})`);

  return {
    authApi,
    db,
    ip,
    user: session?.user as UserModel | undefined,
    runInTransaction: db.transaction.bind(db),
    session,
    repo: repositories,
    eventStore,
    kv,
  };
};

export type ORPCContext = Awaited<ReturnType<typeof createRPCContext>>;
