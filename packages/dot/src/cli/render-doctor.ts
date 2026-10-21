/**
 * `dot doctor`'s verdict and text renderer.
 *
 * The verdict is the worst severity among every issue in the snapshot:
 *   - `failure` if any issue has severity `error`
 *   - `warning` if any issue has severity `warning` (and no errors)
 *   - `success` otherwise
 */

import type { Ui } from '@arki/cli';

import type { DiagnosticIssue, DiagnosticStatus, DotDiagnosticsSnapshot } from '../diagnostics.js';
import type { DoctorReport, DoctorStatus } from './failures.js';

/** Every issue in the snapshot: top-level, then per unit, action, service and lifecycle entry. */
export function allIssues(snap: DotDiagnosticsSnapshot): DiagnosticIssue[] {
  return [
    ...snap.issues,
    ...snap.plugins.flatMap(p => p.issues),
    ...snap.actions.flatMap(action => action.issues),
    ...snap.services.flatMap(s => s.issues),
    ...snap.lifecycle.flatMap(l => l.issues),
  ];
}

/** The worst severity among all the snapshot's issues. */
export function doctorStatus(snap: DotDiagnosticsSnapshot): DoctorStatus {
  const issues = allIssues(snap);
  if (issues.some(issue => issue.severity === 'error')) return 'failure';
  if (issues.some(issue => issue.severity === 'warning')) return 'warning';
  return 'success';
}

function statusIcon(status: DiagnosticStatus): string {
  switch (status) {
    case 'ok': {
      return '[OK]';
    }
    case 'degraded': {
      return '[WARN]';
    }
    case 'failed': {
      return '[FAIL]';
    }
    case 'skipped': {
      return '[SKIP]';
    }
    case 'missing': {
      return '[MISSING]';
    }
  }
}

function renderIssueLines(issues: readonly DiagnosticIssue[], indent: string): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const sev = issue.severity.toUpperCase();
    lines.push(
      `${indent}- [${sev}] ${issue.code}: ${issue.message}`,
      `${indent}    remediation: ${issue.remediation}`,
      `${indent}    docs: ${issue.docsUrl}`,
    );
  }
  return lines;
}

function renderTextDoctor(snap: DotDiagnosticsSnapshot, status: DoctorStatus): string {
  const lines: string[] = [];
  const title = `Doctor: ${snap.app.name} (state=${snap.app.state})`;
  lines.push(
    title,
    '='.repeat(title.length),
    `generatedAt: ${snap.generatedAt}`,
    '',
    `Units (${snap.plugins.length})`,
  );
  if (snap.plugins.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of snap.plugins) {
      lines.push(`  ${statusIcon(p.status)} ${p.plugin}`);
      if (p.issues.length > 0) {
        lines.push(...renderIssueLines(p.issues, '    '));
      }
    }
  }
  lines.push('');

  // Services
  if (snap.services.length > 0) {
    lines.push(`Services (${snap.services.length})`);
    for (const s of snap.services) {
      lines.push(`  ${statusIcon(s.status)} ${s.service} (plugin: ${s.plugin})`);
      if (s.issues.length > 0) {
        lines.push(...renderIssueLines(s.issues, '    '));
      }
    }
    lines.push('');
  }

  // Actions
  if (snap.actions.length > 0) {
    lines.push(`Actions (${snap.actions.length})`);
    for (const action of snap.actions) {
      lines.push(`  ${statusIcon(action.status)} ${action.binding}:${action.id} (plugin: ${action.plugin})`);
      if (action.summary !== undefined) lines.push(`      ↳ ${action.summary}`);
      if (action.issues.length > 0) {
        lines.push(...renderIssueLines(action.issues, '    '));
      }
    }
    lines.push('');
  }

  // Lifecycle issues
  const lifeWithIssues = snap.lifecycle.filter(l => l.issues.length > 0);
  if (lifeWithIssues.length > 0) {
    lines.push(`Lifecycle issues (${lifeWithIssues.length})`);
    for (const l of lifeWithIssues) {
      lines.push(`  ${l.plugin}:${l.hook} (order=${l.order}, state=${l.state})`, ...renderIssueLines(l.issues, '    '));
    }
    lines.push('');
  }

  // Top-level issues (kernel-level / cross-cutting)
  if (snap.issues.length > 0) {
    lines.push(`App-level issues (${snap.issues.length})`, ...renderIssueLines(snap.issues, '  '), '');
  }

  // Summary
  lines.push(`Summary: ${status.toUpperCase()}`);
  return lines.join('\n');
}

/** Print the report as text: per-unit status, services, actions, lifecycle and app-level issues, the verdict. */
export function renderDoctorText(report: DoctorReport, ui: Ui): void {
  ui.out(renderTextDoctor(report, report.status));
}
