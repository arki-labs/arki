/**
 * Diagnostics contract tests for the DOT kernel.
 *
 * The snapshot exposes five top-level arrays — pips, actions, services,
 * lifecycle, issues — and every `DiagnosticIssue` carries code, severity,
 * message, remediation, and docsUrl.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { pip } from '../pip-contract.js';

describe('DOT diagnostics', () => {
  it('pre-boot diagnostics include all five arrays', () => {
    const p = pip({
      name: 'p',
      configure: ctx => {
        ctx.registerService('logger', 'logger');
        ctx.registerAction({ id: 'p.ping', binding: 'orpc', direction: 'in' });
      },
    });
    const configured = defineApp('test').use(p).configure();
    const snap = configured.diagnostics;
    expect(snap.snapshotVersion).toBe(2);
    expect(snap.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(snap.app).toEqual({ name: 'test', state: 'configured' });
    expect(Array.isArray(snap.pips)).toBe(true);
    expect(Array.isArray(snap.actions)).toBe(true);
    expect(Array.isArray(snap.services)).toBe(true);
    expect(Array.isArray(snap.lifecycle)).toBe(true);
    expect(Array.isArray(snap.issues)).toBe(true);
    expect(snap.pips).toHaveLength(1);
    expect(snap.pips[0]).toMatchObject({ pip: 'p', status: 'ok' });
    expect(snap.actions).toEqual([{ id: 'p.ping', pip: 'p', binding: 'orpc', status: 'ok', issues: [] }]);
  });

  it('empty app still exposes all five arrays', async () => {
    const app = await defineApp('empty').boot();
    const snap = app.diagnostics;
    expect(snap.pips).toEqual([]);
    expect(snap.actions).toEqual([]);
    expect(snap.services).toEqual([]);
    expect(snap.lifecycle).toEqual([]);
    expect(snap.issues).toEqual([]);
    await app.dispose();
  });

  it('post-boot diagnostics include per-pip status', async () => {
    const a = pip({ name: 'a', boot: () => ({}) });
    const app = await defineApp('test').use(a).boot();
    const snap = app.diagnostics;
    expect(snap.pips).toEqual([{ pip: 'a', status: 'ok', issues: [] }]);
    expect(snap.lifecycle.some(l => l.hook === 'boot' && l.pip === 'a')).toBe(true);
    await app.dispose();
  });

  it('boot failure surfaces a failed pip diagnostic with structured issue', async () => {
    const bad = pip({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    // The DotApp wrapper isn't returned on failure, but the configure() seam
    // gives us access through a fresh builder. Re-build to inspect.
    const configured = defineApp('test').use(bad).configure();
    // configure succeeded — to surface boot diagnostics, drive boot via the
    // builder and re-read diagnostics on the configured object.
    try {
      await configured.boot();
    } catch {
      // expected — boot threw.
    }
    const bootedSnap = configured.diagnostics;
    expect(bootedSnap.app.state).toBe('failed');
    const badDiag = bootedSnap.pips.find(p => p.pip === 'bad');
    expect(badDiag?.status).toBe('failed');
    expect(badDiag?.issues.length).toBeGreaterThan(0);

    const issue = badDiag!.issues[0]!;
    expect(issue.code).toBeTruthy();
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('bad');
    expect(issue.remediation).toBeTruthy();
    expect(issue.docsUrl).toMatch(/^https?:\/\//);
  });

  it('every DiagnosticIssue carries code, severity, message, remediation, docsUrl', async () => {
    // Surfacing issues needs a configured app whose boot fails — the
    // configured() seam holds the underlying impl whose diagnostics we can
    // read after a boot throw.
    const bootBad = pip({
      name: 'bootbad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const seam = defineApp('test').use(bootBad).configure();
    try {
      await seam.boot();
    } catch {
      // expected
    }
    const snap = seam.diagnostics;
    for (const issue of snap.issues) {
      expect(issue.code).toBeTruthy();
      expect(['info', 'warning', 'error']).toContain(issue.severity);
      expect(issue.message).toBeTruthy();
      expect(issue.remediation).toBeTruthy();
      expect(issue.docsUrl).toMatch(/^https?:\/\//);
    }
    expect(snap.issues.length).toBeGreaterThan(0);
  });
});
