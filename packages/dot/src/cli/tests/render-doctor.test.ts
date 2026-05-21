/**
 * Tests for the doctor renderer + main runDoctor flow.
 *
 * Uses synthetic plugins via testApp — no spawn, no temp dirs. Plugin failure
 * tests rely on the kernel's existing diagnostics issue generation (boot
 * throw → `failed` plugin with structured DiagnosticIssue).
 */

import { describe, expect, it, vi } from 'vitest';

import { defineApp } from '../../define-app.js';
import { defineDotPlugin } from '../../plugin-contract.js';
import { testApp } from '../../test-harness.js';
import { runDoctor } from '../index.js';
import { buildDoctorEnvelope, renderDoctor } from '../render-doctor.js';

const FROZEN_NOW = () => new Date('2026-01-01T00:00:00.000Z');

describe('buildDoctorEnvelope', () => {
  it('emits a DotCliEnvelope with all 5 diagnostics arrays on success', async () => {
    const p = defineDotPlugin({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();
    const envelope = buildDoctorEnvelope({ diagnostics: app.diagnostics }, { json: true, now: FROZEN_NOW });

    expect(envelope.status).toBe('success');
    expect(envelope.command).toBe('doctor');
    expect(envelope.generatedAt).toBe('2026-01-01T00:00:00.000Z');

    expect(envelope.data.plugins).toBeInstanceOf(Array);
    expect(envelope.data.routes).toBeInstanceOf(Array);
    expect(envelope.data.services).toBeInstanceOf(Array);
    expect(envelope.data.lifecycle).toBeInstanceOf(Array);
    expect(envelope.data.issues).toBeInstanceOf(Array);

    await app.dispose();
  });

  it('clean-boot app yields status=success with no error-severity issues', async () => {
    const p = defineDotPlugin({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();
    const envelope = buildDoctorEnvelope({ diagnostics: app.diagnostics }, { json: true, now: FROZEN_NOW });
    expect(envelope.status).toBe('success');
    expect(envelope.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    await app.dispose();
  });

  it('failed boot yields status=failure, failed plugin status, structured issue', async () => {
    const bad = defineDotPlugin({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const seam = defineApp('test').use(bad).configure();
    try {
      await seam.boot();
    } catch {
      // expected
    }

    const envelope = buildDoctorEnvelope({ diagnostics: seam.diagnostics }, { json: true, now: FROZEN_NOW });
    expect(envelope.status).toBe('failure');

    const badPlugin = envelope.data.plugins.find(p => p.plugin === 'bad');
    expect(badPlugin?.status).toBe('failed');

    const issue = badPlugin!.issues[0]!;
    expect(issue.code).toBeTruthy();
    expect(issue.remediation).toBeTruthy();
    expect(issue.docsUrl).toMatch(/^https?:\/\//);
  });
});

describe('renderDoctor', () => {
  it('JSON mode writes a parseable envelope', async () => {
    const p = defineDotPlugin({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();

    let written = '';
    const envelope = renderDoctor(
      { diagnostics: app.diagnostics },
      { json: true, now: FROZEN_NOW, out: line => (written += line) },
    );
    expect(written.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(written) as typeof envelope;
    expect(parsed.status).toBe('success');
    expect(parsed.command).toBe('doctor');

    await app.dispose();
  });

  it('text mode includes per-plugin status markers', async () => {
    const p = defineDotPlugin({ name: 'p', boot: () => ({}) });
    const app = await testApp([p]).boot();

    let written = '';
    renderDoctor(
      { diagnostics: app.diagnostics },
      { json: false, now: FROZEN_NOW, out: line => (written += line) },
    );
    expect(written).toContain('[OK]');
    expect(written).toContain('p');
    expect(written).toContain('Summary');

    await app.dispose();
  });
});

describe('runDoctor', () => {
  it('disposes the app after rendering when it booted from a builder', async () => {
    const disposeSpy = vi.fn();
    const p = defineDotPlugin({
      name: 'p',
      boot: () => ({}),
      dispose: () => {
        disposeSpy();
      },
    });

    const builder = testApp([p]);
    let written = '';
    const envelope = await runDoctor(builder, {
      json: true,
      now: FROZEN_NOW,
      out: line => (written += line),
    });

    expect(envelope.status).toBe('success');
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(written).toContain('"command": "doctor"');
  });

  it('does NOT dispose when caller passed an already-booted app', async () => {
    const disposeSpy = vi.fn();
    const p = defineDotPlugin({
      name: 'p',
      boot: () => ({}),
      dispose: () => {
        disposeSpy();
      },
    });

    const app = await testApp([p]).boot();
    let written = '';
    const envelope = await runDoctor(app, {
      json: true,
      now: FROZEN_NOW,
      out: line => (written += line),
    });

    expect(envelope.status).toBe('success');
    expect(disposeSpy).not.toHaveBeenCalled();

    // We're still responsible for disposing it since the CLI didn't.
    await app.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
