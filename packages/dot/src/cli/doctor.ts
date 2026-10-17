/**
 * `dot doctor` logic: boot the app, read its diagnostics, dispose it. A boot
 * that throws is still reported: the configured app's diagnostics say which
 * plugin failed, so failure stays observable instead of opaque.
 */
import type { Failure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { DotApp } from '../define-app.js';
import type { DotDiagnosticsSnapshot } from '../diagnostics.js';
import type { DiscoveredApp } from './discover.js';
import type { DoctorReport } from './failures.js';
import type { GraphData } from './render-graph.js';
import { guards } from './discover.js';
import { DoctorFailed, lifecycleFailed } from './failures.js';
import { probeObservability } from './observability-probe.js';
import { doctorStatus } from './render-doctor.js';
import { renderGraph } from './render-graph.js';

const debugDoctor = getLogger('arki:dot:cli:doctor');

export type DoctorOptions = {
  /** Also check that an OpenTelemetry SDK is registered; a missing one is a warning issue. */
  readonly observability?: boolean | undefined;
  /** Return the observed plugin graph as Mermaid source instead of the diagnostics. */
  readonly graph?: boolean | undefined;
};

/** Fold the observability probe's issue, if any, into the top-level issues. Never mutates the input. */
function withObservability(diagnostics: DotDiagnosticsSnapshot, enabled: boolean): DotDiagnosticsSnapshot {
  if (!enabled) return diagnostics;
  const probeIssue = probeObservability();
  if (!probeIssue) return diagnostics;
  return { ...diagnostics, issues: [...diagnostics.issues, probeIssue] };
}

/** The report, or `dot.doctor_failed` carrying it when an issue is an error or boot threw. */
function reportOf(
  snapshot: DotDiagnosticsSnapshot,
  observability: boolean,
  bootThrew: boolean,
): DoctorReport | Failure {
  const diagnostics = withObservability(snapshot, observability);
  const status = bootThrew ? 'failure' : doctorStatus(diagnostics);
  const report: DoctorReport = { ...diagnostics, status };
  return status === 'failure' ? DoctorFailed(report) : report;
}

/**
 * Run `doctor` on a discovered app. The CLI owns boot and dispose only when
 * it receives a builder or a configured app; an already-booted app is read
 * and left to its caller. With `graph`, a boot that throws returns
 * `dot.doctor_failed` with the diagnostics, not the graph.
 */
export async function runDoctor(
  discovered: DiscoveredApp,
  opts: DoctorOptions = {},
): Promise<DoctorReport | GraphData | Failure> {
  const observability = opts.observability ?? false;
  if (!guards.isDotAppBuilder(discovered) && !guards.isDotAppConfigured(discovered)) {
    if (opts.graph === true) return renderGraph(discovered.manifest);
    return reportOf(discovered.diagnostics, observability, false);
  }

  let configured;
  try {
    configured = guards.isDotAppBuilder(discovered) ? discovered.configure() : discovered;
  } catch (error) {
    return lifecycleFailed(error, 'configure');
  }

  let booted: DotApp<Record<string, unknown>> | null = null;
  try {
    booted = await configured.boot();
  } catch (error) {
    // Swallowed on purpose: the configured app's diagnostics name the failing plugin.
    debugDoctor.debug('boot threw, falling back to configured diagnostics', {
      error: error instanceof Error ? error : String(error),
    });
  }

  try {
    if (booted === null) return reportOf(configured.diagnostics, observability, true);
    // The booted manifest carries the wiring edges observed during boot.
    if (opts.graph === true) return renderGraph(booted.manifest);
    return reportOf(booted.diagnostics, observability, false);
  } finally {
    if (booted) {
      try {
        await booted.dispose();
      } catch (error) {
        debugDoctor.debug('dispose threw', { error: error instanceof Error ? error : String(error) });
      }
    }
  }
}
