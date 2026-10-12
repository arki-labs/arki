/**
 * `dot doctor --observability` probe.
 *
 * Detects whether an OpenTelemetry SDK is registered in the current
 * process. The check is small and uses only the public OTel API:
 *
 *   1. Start a probe span via the kernel's tracer name.
 *   2. Read the span context's `traceId`.
 *   3. End the span.
 *
 * When no SDK is registered, the OTel API returns a `NonRecordingSpan`
 * whose context has the all-zero trace ID sentinel
 * (`'00000000000000000000000000000000'`) and `traceFlags = 0`. A
 * registered SDK produces a real, non-zero trace ID.
 *
 * If no SDK is detected, the probe returns a `DiagnosticIssue` with
 * severity `warning` — lack of an SDK is a deployment choice, not a
 * bug. The remediation points at the docs section that explains how
 * to wire one in.
 */

import { trace } from '@opentelemetry/api';

import type { DiagnosticIssue } from '../diagnostics.js';
import { DotCliErrorCode, dotCliDocsUrl } from './error-codes.js';

/** OTel API sentinel returned by `NonRecordingSpan` when no SDK is registered. */
const ZERO_TRACE_ID = '0'.repeat(32);

/**
 * Run the probe.
 *
 * @returns `null` when an SDK is registered; a `DiagnosticIssue` when not.
 */
export function probeObservability(): DiagnosticIssue | null {
  const probe = trace.getTracer('@arki/dot').startSpan('dot.cli.observability-probe');
  const traceId = probe.spanContext().traceId;
  probe.end();

  if (traceId !== ZERO_TRACE_ID) return null;

  return {
    code: DotCliErrorCode.ObservabilityNoSdk,
    severity: 'warning',
    message:
      'No OpenTelemetry SDK is registered. Lifecycle traces and metrics will not be exported.',
    remediation:
      'Register an OTel SDK (e.g. @opentelemetry/sdk-node with AsyncLocalStorageContextManager) once at app entry, before any DotApp boots. See the docs for a minimal example.',
    docsUrl: dotCliDocsUrl(DotCliErrorCode.ObservabilityNoSdk),
  };
}
