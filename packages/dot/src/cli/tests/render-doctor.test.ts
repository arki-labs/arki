/**
 * Tests for the doctor renderer + main runDoctor flow.
 *
 * Uses synthetic units via testApp — no spawn, no temp dirs. Unit failure
 * tests rely on the kernel's existing diagnostics issue generation (boot
 * throw → `failed` unit with structured DiagnosticIssue).
 */

import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { defineApp } from '../../define-app.js';
import { infra } from '../../unit-contract.js';
import { testApp } from '../../test-harness.js';
import { runDoctor } from '../doctor.js';
import { DoctorFailed } from '../failures.js';
import { allIssues, doctorStatus, renderDoctorText } from '../render-doctor.js';
import { textUi } from './text-ui.js';

const quiet = () =>
  infra({
    name: 'p',
    boot: () => {
      /* side effects only */
    },
  });

describe('doctorStatus', () => {
  it('a clean boot is success: the snapshot has all 5 diagnostics arrays and no error issue', async () => {
    const app = orThrow(await testApp([quiet()]).boot());
    const diagnostics = app.diagnostics;

    expect(doctorStatus(diagnostics)).toBe('success');
    expect(diagnostics.snapshotVersion).toBe(2);
    expect(diagnostics.plugins).toBeInstanceOf(Array);
    expect(diagnostics.actions).toBeInstanceOf(Array);
    expect(diagnostics.services).toBeInstanceOf(Array);
    expect(diagnostics.lifecycle).toBeInstanceOf(Array);
    expect(diagnostics.issues).toBeInstanceOf(Array);
    expect(allIssues(diagnostics).filter(issue => issue.severity === 'error')).toHaveLength(0);

    orThrow(await app.dispose());
  });

  it('a failed boot is failure, with a failed unit and a structured issue', async () => {
    const bad = infra({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const seam = orThrow(defineApp('test').infra(bad).configure());
    expect(await seam.boot()).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('boot-boom') });

    expect(doctorStatus(seam.diagnostics)).toBe('failure');
    const badUnit = seam.diagnostics.plugins.find(p => p.plugin === 'bad');
    expect(badUnit?.status).toBe('failed');

    const issue = badUnit!.issues[0]!;
    expect(issue.code).toBeTruthy();
    expect(issue.remediation).toBeTruthy();
    expect(issue.docsUrl).toMatch(/^https?:\/\//);
  });
});

describe('renderDoctorText', () => {
  it('includes per-unit status markers and the verdict', async () => {
    const app = orThrow(await testApp([quiet()]).boot());
    const { ui, text } = textUi();
    renderDoctorText({ ...app.diagnostics, status: 'success' }, ui);
    expect(text()).toContain('[OK]');
    expect(text()).toContain('p');
    expect(text()).toContain('Summary: SUCCESS');
    expect(text()).toContain('All systems nominal.');
    orThrow(await app.dispose());
  });
});

describe('runDoctor', () => {
  it('disposes the app after reading it when it booted from a builder', async () => {
    const disposeSpy = vi.fn();
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
      dispose: () => {
        disposeSpy();
      },
    });

    const report = await runDoctor(testApp([p]));

    expect(report).toMatchObject({ status: 'success', snapshotVersion: 2 });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT dispose when caller passed an already-booted app', async () => {
    const disposeSpy = vi.fn();
    const p = infra({
      name: 'p',
      boot: () => {
        /* side effects only */
      },
      dispose: () => {
        disposeSpy();
      },
    });

    const app = orThrow(await testApp([p]).boot());
    const report = await runDoctor(app);

    expect(report).toMatchObject({ status: 'success' });
    expect(disposeSpy).not.toHaveBeenCalled();

    // We're still responsible for disposing it since the CLI didn't.
    orThrow(await app.dispose());
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('a boot that throws returns dot.doctor_failed carrying the report, so `.error.data.plugins[]` names the unit', async () => {
    const bad = infra({
      name: 'bad',
      boot: () => {
        throw new Error('boot-boom');
      },
    });
    const result = await runDoctor(defineApp('test').infra(bad));

    expect(isFailure(result)).toBe(true);
    if (!DoctorFailed.is(result)) throw new Error('expected dot.doctor_failed');
    expect(result.data.status).toBe('failure');
    expect(result.data.plugins.find(p => p.plugin === 'bad')?.status).toBe('failed');
  });
});
