/**
 * @arki/admin/server — server-only fleet helpers.
 *
 * Two halves of the same federation protocol:
 *  - {@link createFleetHandler}: mounted by each app at `GET /api/fleet`. Gates
 *    on a constant-time Bearer-token compare, then returns a validated snapshot.
 *  - {@link fetchFleetSnapshot}: used by Foreman to call an app and parse its
 *    response back into a typed snapshot, never trusting the wire.
 *
 * This module reads secrets and uses `node:crypto`, so it is published only
 * under the `node` export condition — a browser bundle cannot resolve it.
 */
import { timingSafeEqual } from 'node:crypto';

import { getLogger } from '@arki/log';

import type { FetchLike } from './client';
import type { FleetSnapshot } from './contract';
import { FLEET_ENDPOINT_PATH, fleetSnapshotSchema } from './contract';
import { AdminInvalidOutput, AdminUnauthenticated, AdminUnreachable } from './failures';

const logger = getLogger('arki:admin:fleet');

/** Constant-time string compare. Returns false fast on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  return scheme.toLowerCase() === 'bearer' ? token : null;
}

/** Produces the app's current {@link FleetSnapshot}. May be async (DB reads). */
export type FleetSnapshotProvider = () => FleetSnapshot | Promise<FleetSnapshot>;

export type CreateFleetHandlerOptions = {
  /**
   * The shared secret Foreman presents. Read from the app's env (e.g.
   * `FOREMAN_TOKEN`). When undefined the endpoint is closed — every request is
   * rejected, so a misconfigured app never leaks data.
   */
  token: string | undefined;
  /**
   * Computes the snapshot. A thrown error becomes `502 { error: "snapshot_failed" }` and a snapshot
   * outside the contract `500 { error: "invalid_snapshot" }`. The cause goes to the app's log only.
   */
  snapshot: FleetSnapshotProvider;
};

/**
 * Build a `Request -> Response` handler for an app's fleet endpoint. Framework
 * agnostic (plain web `Request`/`Response`), so it drops into a TanStack Start
 * server route, a Hono handler, or any fetch-style server.
 *
 * @remarks
 * Onboarding a TanStack Start app to the fleet (`GET /api/fleet` → this handler)
 * also requires adding `fleetVite()` from `@arki/tanstack-start/vite` to the
 * app's `vite.config.ts` plugins. This module is published `node`-only; without
 * the plugin, Vite's client dep-scan follows the route handler's import into
 * `@arki/admin/server` and aborts ("Failed to run dependency scan").
 */
export function createFleetHandler(options: CreateFleetHandlerOptions) {
  return async function fleetHandler(request: Request): Promise<Response> {
    const provided = extractBearerToken(request.headers.get('authorization'));
    if (!options.token || !provided || !safeEqual(provided, options.token)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    let snapshot: FleetSnapshot;
    try {
      snapshot = await options.snapshot();
    } catch (error) {
      // The caller holds the fleet token, not the app's secrets: the cause stays in the log.
      logger.error('Fleet snapshot provider failed: {error}', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: 'snapshot_failed' }, { status: 502 });
    }

    const parsed = fleetSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      logger.error('Fleet snapshot is outside the contract: {issues}', {
        issues: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      });
      return Response.json({ error: 'invalid_snapshot' }, { status: 500 });
    }

    return Response.json(parsed.data);
  };
}

/** A registered app Foreman knows how to reach. `token`/`baseUrl` are server-only. */
export type FleetRegistryEntry = {
  /** App slug, matches {@link FleetInfo.id}. */
  id: string;
  brand: string;
  domain: string;
  /** Origin Foreman fetches against, e.g. `https://shop.example.com`. */
  baseUrl: string;
  /** Shared secret for this app. */
  token: string;
};

/**
 * Result of one federated fetch — a discriminated union so callers handle failure explicitly.
 * `failure` is {@link AdminUnauthenticated} (the app refused the token, HTTP 401 or 403),
 * {@link AdminUnreachable} (no answer, a redirect, or another bad status) or
 * {@link AdminInvalidOutput} (the body is outside the fleet contract).
 */
export type FleetFetchResult =
  | { id: string; ok: true; snapshot: FleetSnapshot }
  | {
      id: string;
      ok: false;
      failure:
        | ReturnType<typeof AdminUnauthenticated>
        | ReturnType<typeof AdminUnreachable>
        | ReturnType<typeof AdminInvalidOutput>;
    };

export type FetchFleetSnapshotOptions = {
  /** Override the global fetch (tests, or a wrapper that guards requests). */
  fetch?: FetchLike;
  /** Per-request timeout; defaults to 5000ms. */
  timeoutMs?: number;
};

/**
 * Fetch and validate one app's snapshot. Never throws — a network error, bad
 * status, or contract mismatch all resolve to `{ ok: false, failure }` so a single
 * unreachable app cannot break the whole fleet view.
 */
export async function fetchFleetSnapshot(
  entry: FleetRegistryEntry,
  options: FetchFleetSnapshotOptions = {},
): Promise<FleetFetchResult> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  try {
    const response = await fetchImpl(new URL(FLEET_ENDPOINT_PATH, entry.baseUrl), {
      headers: { authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return {
        id: entry.id,
        ok: false,
        failure: AdminUnreachable({ detail: `redirect (HTTP ${String(response.status)}) not followed` }),
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        id: entry.id,
        ok: false,
        failure: AdminUnauthenticated({ detail: `HTTP ${String(response.status)}` }),
      };
    }
    if (!response.ok) {
      return { id: entry.id, ok: false, failure: AdminUnreachable({ detail: `HTTP ${String(response.status)}` }) };
    }

    const json: unknown = await response.json();
    const parsed = fleetSnapshotSchema.safeParse(json);
    if (!parsed.success) {
      return {
        id: entry.id,
        ok: false,
        failure: AdminInvalidOutput({ detail: 'response did not match fleet contract' }),
      };
    }

    return { id: entry.id, ok: true, snapshot: parsed.data };
  } catch (error) {
    // A network error, a timeout or an unreadable body: the app did not answer usably.
    return {
      id: entry.id,
      ok: false,
      failure: AdminUnreachable({ detail: 'the app did not answer the fleet request' }, { cause: error }),
    };
  }
}

export type { FleetSnapshot } from './contract';

// Protocol 2 — the signed dispatcher (portable; re-exported here because apps mount it server-side).
export type { CreateForemanHandlerOptions, NonceStore, PublicKeyRing } from './dispatcher';
export { createForemanHandler } from './dispatcher';
export type { ForemanEnvironment, ForemanManifest, ProviderReadiness, WritesMode } from './protocol';
export {
  FOREMAN_BASE_PATH,
  FOREMAN_PROTOCOL_VERSION,
  foremanEnvironmentSchema,
  foremanManifestSchema,
  generateForemanKeyPair,
  NONCE_TTL_SECONDS,
} from './protocol';
export type { ForemanAppOptions } from './foreman-app';
export type {
  ReceiptAnswer,
  ReceiptClaimResult,
  ReceiptKV,
  ReceiptStore,
  KvReceiptStoreOptions,
  PendingReceipt,
  SettledReceipt,
  StoredReceipt,
} from './receipts';
export { kvReceiptStore, RECEIPT_WINDOW_SECONDS } from './receipts';
export { createForemanHandlerFromEnv } from './foreman-app';
export type { ForemanRouteOptions, ForemanStore } from './foreman-route';
export { createForemanRoute, memoryForemanStore } from './foreman-route';
