/**
 * Diagnostics contract tests for the DOT kernel.
 *
 * The snapshot exposes five top-level arrays — plugins, actions, services,
 * lifecycle, issues — and every `DiagnosticIssue` carries code, severity,
 * message, remediation, and docsUrl.
 */

import { describe, expect, it } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { plugin } from '../plugin-contract.js';

describe('DOT diagnostics', () => {
  it('pre-boot diagnostics include all five arrays', () => {
    const p = plugin({
      name: 'p',
      configure: ctx => {
        ctx.registerService('logger', 'logger');
        ctx.registerAction({ id: 'p.ping', binding: 'orpc', direction: 'in' });
      },
    });
    const configured = orThrow(defineApp('test').use(p).configure());
    const snap = configured.diagnostics;
    expect(snap.snapshotVersion).toBe(2);
    expect(snap.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(snap.app).toEqual({ name: 'test', state: 'configured' });
    expect(Array.isArray(snap.plugins)).toBe(true);
    expect(Array.isArray(snap.actions)).toBe(true);
    expect(Array.isArray(snap.services)).toBe(true);
    expect(Array.isArray(snap.lifecycle)).toBe(true);
    expect(Array.isArray(snap.issues)).toBe(true);
    expect(snap.plugins).toHaveLength(1);
    expect(snap.plugins[0]).toMatchObject({ plugin: 'p', status: 'ok' });
    expect(snap.actions).toEqual([{ id: 'p.ping', plugin: 'p', binding: 'orpc', status: 'ok', issues: [] }]);
  });

  it('empty app still exposes all five arrays', async () => {
    const app = orThrow(await defineApp('empty').boot());
    const snap = app.diagnostics;
    expect(snap.plugins).toEqual([]);
    expect(snap.actions).toEqual([]);
    expect(snap.services).toEqual([]);
    expect(snap.lifecycle).toEqual([]);
    expect(snap.issues).toEqual([]);
    orThrow(await app.dispose());
  });

  it('post-boot diagnostics include per-plugin status', async () => {
    const a = plugin({
      name: 'a',
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await defineApp('test').use(a).boot());
    const snap = app.diagnostics;
    expect(snap.plugins).toEqual([{ plugin: 'a', status: 'ok', issues: [] }]);
    expect(snap.lifecycle.some(l => l.hook === 'boot' && l.plugin === 'a')).toBe(true);
    orThrow(await app.dispose());
  });

  it('boot failure surfaces a failed plugin diagnostic with structured issue', async () => {
    const bad = plugin({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    // The DotApp wrapper isn't returned on failure, but the configure() seam
    // gives us access through a fresh builder. Re-build to inspect.
    const configured = orThrow(defineApp('test').use(bad).configure());
    // configure succeeded — to surface boot diagnostics, drive boot via the
    // builder and re-read diagnostics on the configured object.
    expect(await configured.boot()).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('boot-boom') });
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
    const bootBad = plugin({
      name: 'bootbad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const seam = orThrow(defineApp('test').use(bootBad).configure());
    expect(await seam.boot()).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('boot-boom') });
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
