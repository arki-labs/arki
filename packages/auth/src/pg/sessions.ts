/**
 * Session management bound to the principal. A principal can only list and revoke its own
 * sessions; the summaries never carry the token.
 */
import type { AnyPrincipal } from '../principal.js';
import type { AuthEngine } from './engine.js';
import type { AuthSessions, SessionSummary } from './types.js';
import { log } from '../log.js';
import { isSessionId } from '../principal.js';

type EngineContext = Awaited<AuthEngine['$context']>;

export function createSessions<P extends AnyPrincipal, SId extends string, UId extends string>(
  context: () => Promise<EngineContext>,
): AuthSessions<P, SId, UId> {
  const adapter = async () => {
    const engine = await context();
    return engine.internalAdapter;
  };
  const activeSessions = async (userId: string) => {
    const now = Date.now();
    const internal = await adapter();
    const sessions = await internal.listSessions(userId);
    return sessions.filter(session => session.expiresAt.getTime() > now);
  };

  return {
    async list(principal) {
      const summaries: SessionSummary<SId>[] = [];
      for (const session of await activeSessions(principal.user.id)) {
        if (!isSessionId<SId>(session.id)) continue;
        summaries.push({
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress ?? null,
          userAgent: session.userAgent ?? null,
          current: session.id === principal.session.id,
        });
      }
      return summaries;
    },
    async revoke(principal, id) {
      const sessions = await activeSessions(principal.user.id);
      const session = sessions.find(candidate => candidate.id === id);
      if (session === undefined) return;
      const internal = await adapter();
      await internal.deleteSession(session.token);
      log.debug('Revoked one session');
    },
    async revokeOthers(principal) {
      const sessions = await activeSessions(principal.user.id);
      const tokens = sessions.filter(session => session.id !== principal.session.id).map(session => session.token);
      const internal = await adapter();
      if (tokens.length > 0) await internal.deleteSessions(tokens);
      log.debug('Revoked {count} other sessions', { count: tokens.length });
    },
    async revokeUser(userId) {
      const internal = await adapter();
      await internal.deleteUserSessions(userId);
      log.debug('Revoked every session of a user');
    },
  };
}
