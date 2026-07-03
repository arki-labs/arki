/**
 * Tests for the `dot doctor --observability` probe.
 *
 * Two regimes:
 *   - No SDK registered → probe returns a warning DiagnosticIssue with
 *     code `DOT_CLI_E007`.
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

import { runDoctor } from '../index.js';
import { probeObservability } from '../observability-probe.js';
import { defineApp } from '../../define-app.js';
import { pip } from '../../pip-contract.js';
import { testApp } from '../../test-harness.js';

describe('probeObservability — direct', () => {
  it('returns a coded warning issue when no SDK is registered', () => {
    // Make sure no SDK is hanging around from a sibling test file.
    trace.disable();

    const issue = probeObservability();
    expect(issue).not.toBeNull();
    expect(issue?.code).toBe('DOT_CLI_E007');
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

  it('without --observability, no DOT_CLI_E007 issue appears in the envelope', async () => {
    const p = pip({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();
    try {
      let written = '';
      const envelope = await runDoctor(app, {
        json: true,
        out: (line: string) => {
          written += line;
        },
      });
      expect(envelope.errors.some(e => e.code === 'DOT_CLI_E007')).toBe(false);
      expect(written.length).toBeGreaterThan(0);
    } finally {
      await app.dispose();
    }
  });

  it('with --observability and no SDK, the envelope carries a DOT_CLI_E007 warning issue', async () => {
    const p = pip({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();
    try {
      const envelope = await runDoctor(app, {
        json: true,
        out: () => undefined,
        observability: true,
      });
      const obsIssue = envelope.errors.find(e => e.code === 'DOT_CLI_E007');
      expect(obsIssue).toBeDefined();
      expect(obsIssue?.severity).toBe('warning');
      // Warning-only — envelope should not be `failure` solely because of OTel.
      expect(envelope.status).not.toBe('failure');
    } finally {
      await app.dispose();
    }
  });

  it('with --observability and an SDK registered, no DOT_CLI_E007 issue appears', async () => {
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    try {
      const p = pip({ name: 'p', boot: () => ({}) });
      const app = await testApp([p]).boot();
      try {
        const envelope = await runDoctor(app, {
          json: true,
          out: () => undefined,
          observability: true,
        });
        expect(envelope.errors.some(e => e.code === 'DOT_CLI_E007')).toBe(false);
      } finally {
        await app.dispose();
      }
    } finally {
      trace.disable();
    }
  });

  it('with --observability and a boot failure, both the failure AND the OTel warning surface', async () => {
    const bad = pip({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const builder = defineApp('test').use(bad);

    const envelope = await runDoctor(builder, {
      json: true,
      out: () => undefined,
      observability: true,
    });

    expect(envelope.status).toBe('failure');
    // The boot-failed issue from the kernel must still be present.
    expect(envelope.errors.some(e => e.severity === 'error')).toBe(true);
    // The OTel warning must ALSO be present.
    expect(envelope.errors.some(e => e.code === 'DOT_CLI_E007')).toBe(true);
  });
});
