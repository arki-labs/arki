/**
 * Base-vs-head report for CI, in the spirit of benchstat: one row per case,
 * the change with its interval, and a status word. The last line is the
 * verdict CI acts on.
 */
import type { RunComparison } from '../types.js';
import { formatPercentChange, formatQuantity, formatThreshold } from './format.js';
import { escapeCell } from './markdown.js';

type Row = RunComparison['rows'][number];

const STATUS_TEXT: Readonly<Record<Row['status'], string>> = {
  regressed: 'regressed',
  improved: 'improved',
  within: 'within tolerance',
  inconclusive: 'inconclusive',
  incompatible: 'incompatible',
  added: 'added',
  removed: 'removed',
  'contract-failed': 'contract failed',
};

function value(amount: number | undefined, unit: string | undefined): string {
  return amount === undefined ? '—' : formatQuantity(amount, unit);
}

function change(row: Row): string {
  if (row.ratio === undefined) return '—';
  const interval = row.interval
    ? ` [${formatPercentChange(row.interval[0])}, ${formatPercentChange(row.interval[1])}]`
    : '';
  return `${formatPercentChange(row.ratio)}${interval}`;
}

function status(row: Row): string {
  return row.reason ? `${STATUS_TEXT[row.status]} (${row.reason})` : STATUS_TEXT[row.status];
}

/** `FAIL — 2 regressed beyond 5% · 1 improved · 3 within tolerance`. */
export function comparisonSummary(comparison: RunComparison): string {
  const counts = new Map<Row['status'], number>();
  for (const row of comparison.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const regressed = counts.get('regressed') ?? 0;
  const head = `${comparison.status === 'pass' ? 'PASS' : 'FAIL'} — ${regressed === 0 ? 'none' : regressed} regressed beyond ${formatThreshold(comparison.threshold)}`;
  const rest = (['contract-failed', 'improved', 'within', 'inconclusive', 'incompatible', 'added', 'removed'] as const)
    .filter(key => (counts.get(key) ?? 0) > 0)
    .map(key => `${counts.get(key) ?? 0} ${STATUS_TEXT[key]}`);
  return [head, ...rest].join(' · ');
}

function textTable(comparison: RunComparison): string {
  const header = ['group/case', 'base', 'head', 'change [95% interval]', 'status'];
  const rows = comparison.rows.map(row => [
    `${row.group}/${row.case}`,
    value(row.base, row.unit),
    value(row.head, row.unit),
    change(row),
    status(row),
  ]);
  const all = [header, ...rows];
  const widths = header.map((_, index) => Math.max(...all.map(cells => [...(cells[index] ?? '')].length)));
  const lines = all.map(cells =>
    cells
      .map((cell, index) => {
        const gap = ' '.repeat((widths[index] ?? 0) - [...cell].length);
        return index === 1 || index === 2 ? gap + cell : cell + gap;
      })
      .join('  ')
      .trimEnd(),
  );
  return [
    ...lines,
    '',
    comparisonSummary(comparison),
    ...comparison.warnings.map(warning => `Warning: ${warning}`),
  ].join('\n');
}

function markdownTable(comparison: RunComparison): string {
  const lines = ['| Benchmark | Base | Head | Change [95% interval] | Status |', '| --- | --: | --: | --- | --- |'];
  for (const row of comparison.rows) {
    const cells = [
      `${row.group}/${row.case}`,
      value(row.base, row.unit),
      value(row.head, row.unit),
      change(row),
      status(row),
    ];
    lines.push(`| ${cells.map(cell => escapeCell(cell)).join(' | ')} |`);
  }
  const summary = comparisonSummary(comparison);
  const [verdict = '', ...rest] = summary.split(' — ');
  const warnings = comparison.warnings.map(warning => `> **Warning:** ${escapeCell(warning)}`);
  return [...lines, '', `**${verdict}** — ${rest.join(' — ')}`, ...(warnings.length > 0 ? ['', ...warnings] : [])].join(
    '\n',
  );
}

/** Renders a base-vs-head comparison as an aligned text table or a Markdown table (for PR comments). */
export function renderComparison(comparison: RunComparison, format: 'text' | 'markdown'): string {
  return `${format === 'markdown' ? markdownTable(comparison) : textTable(comparison)}\n`;
}
