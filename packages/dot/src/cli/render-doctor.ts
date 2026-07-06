/**
 * Renderers for `dot doctor`.
 *
 * Reads a booted (or fully-failed) app's `diagnostics` snapshot and emits
 * either a JSON envelope or a human-readable per-pip status report.
 *
 * Envelope `status` reflects the worst severity present:
 *   - `failure` if any issue has severity `error`
 *   - `warning` if any issue has severity `warning` (and no errors)
 *   - `success` otherwise
 */

import type { DiagnosticIssue, DiagnosticStatus, DotDiagnosticsSnapshot } from '../diagnostics.js';
import type { DotCliEnvelope, DotCliEnvelopeStatus, RenderOptions } from './render-explain.js';

export type DoctorSource = {
  diagnostics: DotDiagnosticsSnapshot;
};

const defaultOut = (line: string) => {
  process.stdout.write(line);
};

function nowIso(opts: RenderOptions): string {
  const factory = opts.now ?? (() => new Date());
  return factory().toISOString();
}

/**
 * Walk every issue carried anywhere in the snapshot (top-level + per-pip +
 * per-route + per-service + per-lifecycle entry) and pick the worst severity.
 */
function worstSeverity(snap: DotDiagnosticsSnapshot): DotCliEnvelopeStatus {
  let hasWarning = false;

  const collect = (issues: readonly DiagnosticIssue[]): void => {
    for (const issue of issues) {
      if (issue.severity === 'error') {
        // Short-circuit through a thrown sentinel is overkill; track a flag.
        hasError = true;
      } else if (issue.severity === 'warning') {
        hasWarning = true;
      }
    }
  };

  let hasError = false;
  collect(snap.issues);
  for (const p of snap.pips) collect(p.issues);
  for (const r of snap.routes) collect(r.issues);
  for (const s of snap.services) collect(s.issues);
  for (const l of snap.lifecycle) collect(l.issues);

  if (hasError) return 'failure';
  if (hasWarning) return 'warning';
  return 'success';
}

/**
 * Compose the JSON envelope. Pure — no IO. Useful for tests and embedding.
 */
export function buildDoctorEnvelope(
  source: DoctorSource,
  opts: RenderOptions,
): DotCliEnvelope<DotDiagnosticsSnapshot> {
  const status = worstSeverity(source.diagnostics);

  // Top-level `errors` is the flat list of every issue, so agents can fail
  // fast without walking the nested arrays.
  const errors: DiagnosticIssue[] = [];
  const collect = (issues: readonly DiagnosticIssue[]): void => {
    for (const issue of issues) errors.push(issue);
  };
  collect(source.diagnostics.issues);
  for (const p of source.diagnostics.pips) collect(p.issues);
  for (const r of source.diagnostics.routes) collect(r.issues);
  for (const s of source.diagnostics.services) collect(s.issues);
  for (const l of source.diagnostics.lifecycle) collect(l.issues);

  return {
    status,
    command: 'doctor',
    generatedAt: nowIso(opts),
    data: source.diagnostics,
    errors,
  };
}

function statusIcon(status: DiagnosticStatus): string {
  switch (status) {
    case 'ok':
      return '[OK]';
    case 'degraded':
      return '[WARN]';
    case 'failed':
      return '[FAIL]';
    case 'skipped':
      return '[SKIP]';
    case 'missing':
      return '[MISSING]';
  }
}

function renderIssueLines(issues: readonly DiagnosticIssue[], indent: string): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const sev = issue.severity.toUpperCase();
    lines.push(`${indent}- [${sev}] ${issue.code}: ${issue.message}`);
    lines.push(`${indent}    remediation: ${issue.remediation}`);
    lines.push(`${indent}    docs: ${issue.docsUrl}`);
  }
  return lines;
}

function renderTextDoctor(snap: DotDiagnosticsSnapshot, status: DotCliEnvelopeStatus): string {
  const lines: string[] = [];
  const title = `Doctor: ${snap.app.name} (state=${snap.app.state})`;
  lines.push(title);
  lines.push('='.repeat(title.length));
  lines.push(`generatedAt: ${snap.generatedAt}`);
  lines.push('');

  // Per-pip status
  lines.push(`Pips (${snap.pips.length})`);
  if (snap.pips.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of snap.pips) {
      lines.push(`  ${statusIcon(p.status)} ${p.pip}`);
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
      lines.push(`  ${statusIcon(s.status)} ${s.service} (pip: ${s.pip})`);
      if (s.issues.length > 0) {
        lines.push(...renderIssueLines(s.issues, '    '));
      }
    }
    lines.push('');
  }

  // Routes
  if (snap.routes.length > 0) {
    lines.push(`Routes (${snap.routes.length})`);
    for (const r of snap.routes) {
      lines.push(`  ${statusIcon(r.status)} ${r.id} (pip: ${r.pip})`);
      if (r.issues.length > 0) {
        lines.push(...renderIssueLines(r.issues, '    '));
      }
    }
    lines.push('');
  }

  // Lifecycle issues
  const lifeWithIssues = snap.lifecycle.filter(l => l.issues.length > 0);
  if (lifeWithIssues.length > 0) {
    lines.push(`Lifecycle issues (${lifeWithIssues.length})`);
    for (const l of lifeWithIssues) {
      lines.push(`  ${l.pip}:${l.hook} (order=${l.order}, state=${l.state})`);
      lines.push(...renderIssueLines(l.issues, '    '));
    }
    lines.push('');
  }

  // Top-level issues (kernel-level / cross-cutting)
  if (snap.issues.length > 0) {
    lines.push(`App-level issues (${snap.issues.length})`);
    lines.push(...renderIssueLines(snap.issues, '  '));
    lines.push('');
  }

  // Summary
  lines.push(`Summary: ${status.toUpperCase()}`);
  return lines.join('\n');
}

/**
 * Render the doctor output. Returns the envelope so callers can act on it
 * (e.g. set the process exit code based on `status`).
 */
export function renderDoctor(source: DoctorSource, opts: RenderOptions): DotCliEnvelope<DotDiagnosticsSnapshot> {
  const envelope = buildDoctorEnvelope(source, opts);
  const out = opts.out ?? defaultOut;

  if (opts.json) {
    out(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    out(`${renderTextDoctor(source.diagnostics, envelope.status)}\n`);
  }

  return envelope;
}
