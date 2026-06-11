/**
 * Fleet administration contract.
 *
 * Every ARKI app that wants to appear in Foreman (admin.fork.works) exposes a
 * single authenticated endpoint that returns a {@link FleetSnapshot}. Foreman
 * fetches each app's snapshot and validates it against this same schema, so the
 * two sides agree on shape without sharing a runtime or an oRPC router. The
 * contract is intentionally small and additive: new per-app numbers go into
 * `metrics.custom` rather than new top-level fields.
 */
import { z } from '@arki/contracts';

/** Well-known path each app mounts its fleet endpoint at. */
export const FLEET_ENDPOINT_PATH = '/api/fleet';

/** Auth scheme Foreman uses on the fleet endpoint (`Authorization: Bearer <token>`). */
export const FLEET_AUTH_SCHEME = 'Bearer';

/**
 * Wire-format version. Bump only on a breaking change to the snapshot shape so
 * Foreman can detect an app that is running an incompatible contract.
 */
export const FLEET_PROTOCOL_VERSION = 1;

/** Identity of an app in the fleet — safe to render in the UI (no secrets). */
export const fleetInfoSchema = z.object({
  /** Stable app slug, e.g. `forkworks`. Matches the apps/ folder name. */
  id: z.string().min(1),
  /** Human brand name, e.g. `Forkworks`. */
  brand: z.string().min(1),
  /** Public production domain, e.g. `fork.works`. */
  domain: z.string().min(1),
  /** App version or build identifier (package version, git sha, …). */
  version: z.string().min(1),
  /** Which environment produced this snapshot. */
  environment: z.enum(['production', 'preview', 'development']),
  /** Contract version the app implements. */
  protocolVersion: z.number().int().positive(),
});

/** A single app-specific number Foreman renders as a labelled stat. */
export const fleetMetricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.number(),
  /** Optional display unit, e.g. `MB`, `%`, `/day`. */
  unit: z.string().optional(),
  /** Optional one-line explanation shown on hover. */
  hint: z.string().optional(),
});

/** The metrics block every app reports — shared user numbers plus app-specific extras. */
export const fleetMetricsSchema = z.object({
  users: z.object({
    total: z.number().int().nonnegative(),
    new7d: z.number().int().nonnegative(),
    new30d: z.number().int().nonnegative(),
  }),
  /** App-specific stats. Empty array is valid (e.g. a brand-new app). */
  custom: z.array(fleetMetricSchema),
});

/** One dependency check (database, queue, external provider, …). */
export const fleetHealthCheckSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional(),
});

/** Roll-up health for the app. `status` is the worst of its checks. */
export const fleetHealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.array(fleetHealthCheckSchema),
});

/** The full payload an app returns from its fleet endpoint. */
export const fleetSnapshotSchema = z.object({
  info: fleetInfoSchema,
  metrics: fleetMetricsSchema,
  health: fleetHealthSchema,
  /** ISO-8601 timestamp of when the app computed this snapshot. */
  generatedAt: z.string().min(1),
});

export type FleetInfo = z.infer<typeof fleetInfoSchema>;
export type FleetMetric = z.infer<typeof fleetMetricSchema>;
export type FleetMetrics = z.infer<typeof fleetMetricsSchema>;
export type FleetHealthCheck = z.infer<typeof fleetHealthCheckSchema>;
export type FleetHealth = z.infer<typeof fleetHealthSchema>;
export type FleetSnapshot = z.infer<typeof fleetSnapshotSchema>;
