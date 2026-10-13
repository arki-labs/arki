/**
 * ASCII waterfall renderer for DOT lifecycle diagnostics.
 *
 * Given a `DotDiagnosticsSnapshot`, builds a compact per-phase, per-plugin
 * duration chart suitable for printing in a terminal or embedding in a
 * `dot doctor` text report. No colour, no Unicode beyond `█` so the
 * output stays clean in log aggregators and CI.
 *
 * @example
 * ```
 * Timeline: my-app (state=booted)
 * ─────────────────────────────────────────────────────────
 * configure
 *   env       0.5ms  █
 *   db        1.4ms  █████
 *   kv        0.3ms  █
 *
 * boot
 *   env       2.8ms  █████████
 *   db       32.9ms  ███████████████████████████████████████████
 *   kv        3.9ms  ████████████
 * ─────────────────────────────────────────────────────────
 * ```
 *
 * @see packages/dot/docs/observability.md
 */

import type { DotDiagnosticsSnapshot, LifecycleDiagnostic } from './diagnostics.js';
import type { DotLifecycleHook } from './lifecycle.js';

const PHASE_ORDER: readonly DotLifecycleHook[] = ['configure', 'boot', 'start', 'stop', 'dispose'];

const BAR_CHAR = '█';
const DEFAULT_BAR_WIDTH = 50;
const MIN_BAR_FOR_NONZERO = 1;

export type RenderTimelineOptions = {
  /** Maximum bar width in characters (default `50`). */
  readonly barWidth?: number;
  /**
   * When `true`, also emit any plugin's diagnostic `issues[]` underneath
   * the bar so failure reasons are visible in the timeline view.
   * Default `true`.
   */
  readonly showIssues?: boolean;
};

/**
 * Render the snapshot's lifecycle records as a per-phase waterfall.
 * Pure — no IO. Caller is responsible for printing the result.
 */
export function renderTimeline(snapshot: DotDiagnosticsSnapshot, opts: RenderTimelineOptions = {}): string {
  const barWidth = opts.barWidth ?? DEFAULT_BAR_WIDTH;
  const showIssues = opts.showIssues ?? true;

  // Group lifecycle entries by phase, preserving execution order within
  // each phase. The kernel pushes entries in execution order; we filter
  // and re-order here to make the output deterministic when phases are
  // interleaved (currently they aren't, but be defensive).
  const byPhase = new Map<DotLifecycleHook, LifecycleDiagnostic[]>();
  for (const entry of snapshot.lifecycle) {
    const bucket = byPhase.get(entry.hook);
    if (bucket) bucket.push(entry);
    else byPhase.set(entry.hook, [entry]);
  }

  // Scale: the longest duration across all entries sets the full-width bar.
  // Using a single global scale lets readers compare durations across
  // phases at a glance ("boot.db is 10x configure.env").
  let maxDuration = 0;
  for (const entry of snapshot.lifecycle) {
    const d = entry.durationMs ?? 0;
    if (d > maxDuration) maxDuration = d;
  }

  const lines: string[] = [];
  const title = `Timeline: ${snapshot.app.name} (state=${snapshot.app.state})`;
  lines.push(title);
  lines.push('─'.repeat(title.length));

  // Layout: 2-space indent, 10-char plugin column, 8-char duration column, then bar.
  const PLUGIN_COL = 12;
  const DUR_COL = 8;
  const indent = '  ';

  let anyRendered = false;
  for (const phase of PHASE_ORDER) {
    const entries = byPhase.get(phase);
    if (!entries || entries.length === 0) continue;
    if (anyRendered) lines.push('');
    anyRendered = true;
    lines.push(phase);
    for (const entry of entries) {
      const durationMs = entry.durationMs ?? 0;
      const bar = makeBar(durationMs, maxDuration, barWidth);
      const failedMark = entry.state === 'failed' ? ' ✗' : '';
      const pluginCol = entry.plugin.padEnd(PLUGIN_COL);
      const durCol = formatDuration(durationMs).padStart(DUR_COL);
      lines.push(`${indent}${pluginCol}${durCol}  ${bar}${failedMark}`);
      if (showIssues && entry.issues.length > 0) {
        for (const issue of entry.issues) {
          lines.push(`${indent}  └─ ${issue.code}: ${issue.message}`);
        }
      }
    }
  }

  if (!anyRendered) {
    lines.push('(no lifecycle entries — app has not run any phase yet)');
  } else {
    lines.push('─'.repeat(title.length));
  }

  return lines.join('\n');
}

/**
 * Build the bar string. Zero-duration entries get a single block (so they
 * are still visually present); otherwise width is proportional to the
 * global max.
 */
function makeBar(duration: number, max: number, width: number): string {
  if (max <= 0) return '';
  if (duration <= 0) return BAR_CHAR.repeat(MIN_BAR_FOR_NONZERO);
  const cells = Math.max(MIN_BAR_FOR_NONZERO, Math.round((duration / max) * width));
  return BAR_CHAR.repeat(cells);
}

/**
 * Format a duration in milliseconds with one decimal place. Caps the
 * decimal at sub-second values; values ≥ 1000ms render as integer ms
 * to keep the column tight.
 */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}
