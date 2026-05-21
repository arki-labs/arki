/**
 * Diagnostics contract tests for the DOT kernel.
 *
 * The snapshot exposes five top-level arrays — plugins, routes, services,
 * lifecycle, issues — and every `DiagnosticIssue` carries code, severity,
 * message, remediation, and docsUrl.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app';
import { defineDotPlugin } from '../plugin-contract';

describe('DOT diagnostics', () => {
  it('pre-boot diagnostics include all five arrays', () => {
    const p = defineDotPlugin({
      name: 'p',
      configure: ctx => {
        ctx.registerService('logger', 'logger');
        ctx.registerRoute({ id: 'p.ping', transport: 'orpc' });
      },
    });
    const configured = defineApp('test').use(p).configure();
    const snap = configured.diagnostics;
    expect(snap.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(snap.app).toEqual({ name: 'test', state: 'configured' });
    expect(Array.isArray(snap.plugins)).toBe(true);
    expect(Array.isArray(snap.routes)).toBe(true);
    expect(Array.isArray(snap.services)).toBe(true);
    expect(Array.isArray(snap.lifecycle)).toBe(true);
    expect(Array.isArray(snap.issues)).toBe(true);
    expect(snap.plugins).toHaveLength(1);
    expect(snap.plugins[0]).toMatchObject({ plugin: 'p', status: 'ok' });
  });

  it('empty app still exposes all five arrays', async () => {
    const app = await defineApp('empty').boot();
    const snap = app.diagnostics;
    expect(snap.plugins).toEqual([]);
    expect(snap.routes).toEqual([]);
    expect(snap.services).toEqual([]);
    expect(snap.lifecycle).toEqual([]);
    expect(snap.issues).toEqual([]);
    await app.dispose();
  });

  it('post-boot diagnostics include per-plugin status', async () => {
    const a = defineDotPlugin({ name: 'a', boot: () => ({}) });
    const app = await defineApp('test').use(a).boot();
    const snap = app.diagnostics;
    expect(snap.plugins).toEqual([{ plugin: 'a', status: 'ok', issues: [] }]);
    expect(snap.lifecycle.some(l => l.hook === 'boot' && l.plugin === 'a')).toBe(true);
    await app.dispose();
  });

  it('boot failure surfaces a failed plugin diagnostic with structured issue', async () => {
    const bad = defineDotPlugin({
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
    const badDiag = bootedSnap.plugins.find(p => p.plugin === 'bad');
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
    const bootBad = defineDotPlugin({
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
