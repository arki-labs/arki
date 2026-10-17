/**
 * Tests for the `dot doctor --observability` probe.
 *
 * Two regimes:
 *   - No SDK registered → probe returns a warning DiagnosticIssue with
 *     code `dot.observability_no_sdk`.
 *   - SDK registered → probe returns `null`.
 *
 * SDK registration here uses `@opentelemetry/sdk-trace-base` with a
 * `BasicTracerProvider` — same shape `NodeSDK` would set up under the
 * hood but without the Node-specific exporter machinery. The kernel's
 * existing OTel test in `kernel/otel.test.ts` uses the same approach,
 * so we're matching the established convention.
 */

import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { DoctorReport } from '../failures.js';
import { defineApp } from '../../define-app.js';
import { plugin } from '../../plugin-contract.js';
import { testApp } from '../../test-harness.js';
import { runDoctor } from '../doctor.js';
import { DoctorFailed } from '../failures.js';
import { probeObservability } from '../observability-probe.js';
import { allIssues } from '../render-doctor.js';

/** The doctor report, whether doctor passed or returned `dot.doctor_failed`. */
function reportOf(result: Awaited<ReturnType<typeof runDoctor>>): DoctorReport {
  if (DoctorFailed.is(result)) return result.data;
  if (isFailure(result) || !('snapshotVersion' in result)) throw new Error('expected a doctor report');
  return result;
}

describe('probeObservability — direct', () => {
  it('returns a coded warning issue when no SDK is registered', () => {
    // Make sure no SDK is hanging around from a sibling test file.
    trace.disable();

    const issue = probeObservability();
    expect(issue).not.toBeNull();
    expect(issue?.code).toBe('dot.observability_no_sdk');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toMatch(/No OpenTelemetry SDK is registered/);
    expect(issue?.remediation).toMatch(/Register an OTel SDK/);
    expect(issue?.docsUrl).toMatch(/^https?:\/\//);
  });

  it('returns null when an SDK is registered', () => {
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    try {
      const issue = probeObservability();
      expect(issue).toBeNull();
    } finally {
      trace.disable();
    }
  });
});

describe('runDoctor — --observability flag', () => {
  beforeEach(() => {
    // Start each test with no SDK so the probe defaults to "no SDK" unless
    // a specific test installs one.
    trace.disable();
  });

  afterEach(() => {
    trace.disable();
  });

  it('without --observability, no dot.observability_no_sdk issue appears in the envelope', async () => {
    const p = plugin({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = await testApp([p]).boot();
    try {
      const envelope = reportOf(await runDoctor(app));
      expect(allIssues(envelope).some(e => e.code === 'dot.observability_no_sdk')).toBe(false);
    } finally {
      await app.dispose();
    }
  });

  it('with --observability and no SDK, the envelope carries a dot.observability_no_sdk warning issue', async () => {
    const p = plugin({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
    });
    const app = await testApp([p]).boot();
    try {
      const envelope = reportOf(await runDoctor(app, { observability: true }));
      const obsIssue = allIssues(envelope).find(e => e.code === 'dot.observability_no_sdk');
      expect(obsIssue).toBeDefined();
      expect(obsIssue?.severity).toBe('warning');
      // Warning-only: the report must not be `failure` solely because of OTel.
      expect(envelope.status).not.toBe('failure');
    } finally {
      await app.dispose();
    }
  });

  it('with --observability and an SDK registered, no dot.observability_no_sdk issue appears', async () => {
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    try {
      const p = plugin({
        name: 'p',
        boot: () => {
          /* side effects only */
        },
      });
      const app = await testApp([p]).boot();
      try {
        const envelope = reportOf(await runDoctor(app, { observability: true }));
        expect(allIssues(envelope).some(e => e.code === 'dot.observability_no_sdk')).toBe(false);
      } finally {
        await app.dispose();
      }
    } finally {
      trace.disable();
    }
  });

  it('with --observability and a boot failure, both the failure AND the OTel warning surface', async () => {
    const bad = plugin({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const builder = defineApp('test').use(bad);

    const envelope = reportOf(await runDoctor(builder, { observability: true }));

    expect(envelope.status).toBe('failure');
    // The boot-failed issue from the kernel must still be present.
    expect(allIssues(envelope).some(e => e.severity === 'error')).toBe(true);
    // The OTel warning must ALSO be present.
    expect(allIssues(envelope).some(e => e.code === 'dot.observability_no_sdk')).toBe(true);
  });
});
