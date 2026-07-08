/**
 * Diagnostics types for the DOT kernel.
 *
 * Where the manifest describes the static shape of an app, a
 * `DotDiagnosticsSnapshot` is a point-in-time observability record: the
 * lifecycle state of the app and every plugin, plus structured issues with
 * remediation guidance.
 *
 * CONTRACT: `DotDiagnosticsSnapshot` always exposes the same five arrays
 * (`plugins`, `actions`, `services`, `lifecycle`, `issues`). Consumers must
 * never see an omitted array — empty is empty, but never missing.
 * This is the "5 arrays" contract referenced by the kernel spec.
 */

import type { DotLifecycleHook, DotLifecycleState } from './lifecycle.js';

/** Severity of a single diagnostic issue. */
export type DiagnosticSeverity = 'info' | 'warning' | 'error';

/** Status of a plugin/action/service/lifecycle entry. */
export type DiagnosticStatus = 'ok' | 'degraded' | 'failed' | 'skipped' | 'missing';

/**
 * Single point-in-time diagnostic snapshot of a DotApp.
 *
 * Five top-level arrays — plugins, actions, services, lifecycle, issues —
 * are guaranteed to be present even when empty.
 */
export type DotDiagnosticsSnapshot = {
  /** Diagnostic snapshot schema version. 2 = actions/projections era. */
  snapshotVersion: 2;
  /** ISO-8601 timestamp at which the snapshot was generated. */
  generatedAt: string;
  app: {
    name: string;
    state: DotLifecycleState;
  };
  plugins: PluginDiagnostic[];
  actions: ActionDiagnostic[];
  services: ServiceDiagnostic[];
  lifecycle: LifecycleDiagnostic[];
  issues: DiagnosticIssue[];
};

export type PluginDiagnostic = {
  plugin: string;
  status: Extract<DiagnosticStatus, 'ok' | 'degraded' | 'failed' | 'skipped'>;
  issues: DiagnosticIssue[];
};

export type ActionDiagnostic = {
  id: string;
  plugin: string;
  binding: string;
  /** Structural configure-phase health only; not runtime liveness. */
  status: Extract<DiagnosticStatus, 'ok' | 'degraded' | 'failed'>;
  issues: DiagnosticIssue[];
};

export type ServiceDiagnostic = {
  service: string;
  plugin: string;
  status: Extract<DiagnosticStatus, 'ok' | 'degraded' | 'failed' | 'missing'>;
  issues: DiagnosticIssue[];
};

export type LifecycleDiagnostic = {
  plugin: string;
  hook: DotLifecycleHook;
  state: DotLifecycleState;
  /** 0-based topological order of this plugin within the hook pass. */
  order: number;
  /** Wall-clock duration of the hook call, in milliseconds. */
  durationMs?: number;
  issues: DiagnosticIssue[];
};

/**
 * Single structured issue surfaced by the kernel or by a plugin.
 *
 * `code`, `message`, `remediation` and `docsUrl` are required so that issues
 * are always actionable — never just "something went wrong".
 */
export type DiagnosticIssue = {
  /** Stable machine-readable code, e.g. `DOT_LIFECYCLE_E003`. */
  code: string;
  severity: DiagnosticSeverity;
  plugin?: string;
  message: string;
  /** Human-readable remediation: what the developer should do. */
  remediation: string;
  /** Link to the relevant docs page for this issue. */
  docsUrl: string;
  metadata?: Record<string, unknown>;
};
