import type { CoolifyApplication, CoolifyDeployment, CoolifyServer } from './schemas';

/** Same names as the columns of Foreman's `signals` table (minus ids Foreman assigns). */
export type CoolifySignal = {
  source: 'coolify';
  kind: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  occurredAt: Date;
  externalId: string;
  summary: string;
  payload: Record<string, unknown>;
};

/** Coolify timestamps are ISO or `YYYY-MM-DD HH:MM:SS` (UTC). Falls back when unparseable. */
function toDate(value: string | null | undefined, fallback: Date): Date {
  if (value === null || value === undefined) return fallback;
  const d = new Date(/z|[+-]\d\d:?\d\d$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export function deploymentSignal(d: CoolifyDeployment, fallback: Date): CoolifySignal {
  const status = d.status.toLowerCase();
  const failed = status.includes('fail') || status.includes('error');
  const kind = failed ? 'deploy.failed' : status === 'finished' ? 'deploy.finished' : 'deploy.progress';
  const app = d.application_name ?? 'application';
  return {
    source: 'coolify',
    kind,
    severity: failed ? 'error' : 'info',
    occurredAt: toDate(d.updated_at ?? d.created_at, fallback),
    externalId: `deployment:${d.deployment_uuid}:${status}`,
    summary: `Deployment of ${app} is ${d.status}`,
    payload: { deploymentUuid: d.deployment_uuid, status: d.status, commit: d.commit ?? null },
  };
}

const healthy = (status: string) => status.toLowerCase().startsWith('running');

/** Null when the application is healthy: a healthy read confirms nothing worth a signal. */
export function applicationSignal(a: CoolifyApplication, fallback: Date): CoolifySignal | null {
  const status = a.status ?? 'unknown';
  if (healthy(status)) return null;
  return {
    source: 'coolify',
    kind: 'app.unhealthy',
    severity: 'warning',
    occurredAt: toDate(a.updated_at, fallback),
    externalId: `application:${a.uuid}:${status.toLowerCase()}`,
    summary: `${a.name} is ${status}`,
    payload: { applicationUuid: a.uuid, status },
  };
}

/** Null when the server is reachable. */
export function serverSignal(s: CoolifyServer, fallback: Date): CoolifySignal | null {
  if (s.settings?.is_reachable !== false) return null;
  return {
    source: 'coolify',
    kind: 'server.unreachable',
    severity: 'critical',
    occurredAt: fallback,
    externalId: `server:${s.uuid}:unreachable`,
    summary: `Server ${s.name} is unreachable`,
    payload: { serverUuid: s.uuid },
  };
}
