/**
 * Terminal report: one compact aligned table per group. Plain text by default;
 * ANSI color only when asked, so piped output and logs stay clean.
 */
import type { BenchResult, CaseResult, GroupResult } from '../types.js';
import type { Section, Tone } from './format.js';
import {
  allGroups,
  baselineLabel,
  cpuLabel,
  flagText,
  formatBytes,
  formatQuantity,
  formatSpread,
  headline,
  hostLabel,
  isDeterministic,
  matrixRows,
  plural,
  profileLabel,
  runtimeLabel,
  sections,
  verdictFor,
  versionOf,
} from './format.js';

export type TextOptions = {
  /** ANSI colors. Default false; the CLI turns it on for a TTY. */
  color?: boolean;
};

type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan' | 'redBold';

const CODES: Readonly<Record<Style, string>> = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
  redBold: '1;31',
};

const TONE_STYLE: Readonly<Record<Tone, Style>> = {
  baseline: 'cyan',
  good: 'green',
  bad: 'red',
  neutral: 'dim',
  unknown: 'yellow',
  muted: 'dim',
};

type Paint = (style: Style | undefined, text: string) => string;

const ESC = String.fromCodePoint(27);

function painter(color: boolean): Paint {
  return (style, text) => (color && style && text ? `${ESC}[${CODES[style]}m${text}${ESC}[0m` : text);
}

type Cell = { text: string; style?: Style; align?: 'right' };

const width = (text: string): number => [...text].length;

/** Pads first, paints second, so colors never break the alignment. */
function table(rows: readonly (readonly Cell[])[], paint: Paint, indent = '  '): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [index, cell] of row.entries()) widths[index] = Math.max(widths[index] ?? 0, width(cell.text));
  }
  return rows.map(row => {
    const cells = row.map((cell, index) => {
      const gap = ' '.repeat((widths[index] ?? 0) - width(cell.text));
      const padded = cell.align === 'right' ? gap + paint(cell.style, cell.text) : paint(cell.style, cell.text) + gap;
      return padded;
    });
    return (indent + cells.join('  ')).trimEnd();
  });
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A small horizontal bar, length proportional to value / max, in eighth-block steps. */
export function bar(value: number, max: number, size = 16): string {
  if (!(max > 0) || !(value > 0)) return '';
  const eighths = Math.max(1, Math.round((value / max) * size * 8));
  return '█'.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '');
}

function estimateText(group: GroupResult, row: CaseResult): string {
  if (row.size !== undefined) return `${formatBytes(row.size.gzip)} gzip`;
  const value = formatQuantity(row.summary.estimate, group.unit);
  if (row.summary.interval[0] === row.summary.interval[1]) return value;
  return `${value} ${formatSpread(row.summary.estimate, row.summary.interval)}`;
}

function detailText(row: CaseResult): string {
  const parts: string[] = [];
  if (row.role === 'variant') parts.push('variant');
  for (const flag of row.flags) parts.push(flagText(flag));
  if (row.size !== undefined) parts.push(`br ${formatBytes(row.size.brotli)}`, `raw ${formatBytes(row.size.raw)}`);
  if (row.limit !== undefined) parts.push(`limit ${formatBytes(row.limit)}`);
  return parts.join(' · ');
}

const flagStyle = (row: CaseResult): Style | undefined => (row.flags.length > 0 ? 'yellow' : 'dim');

function contractLines(group: GroupResult, paint: Paint): string[] {
  if (group.kind !== 'compare' || !group.contract) return [];
  const head = `  ${paint('dim', 'contract')} ${group.contract.id}: every ranked row returns ${group.contract.description}`;
  const check = group.check;
  if (!check) return [`${head} · ${paint('yellow', 'not checked')}`];
  if (check.status === 'passed')
    return [`${head} · ${paint('green', `✓ checked on ${plural(check.inputs, 'input')}`)}`];
  const lines = [
    `${head} · ${paint('redBold', `✗ FAILED: ${plural(check.failures.length, 'mismatch', 'mismatches')} on ${plural(check.inputs, 'input')}`)}`,
  ];
  for (const failure of check.failures.slice(0, 5)) {
    lines.push(
      `    ${paint('red', `${failure.case} · input #${failure.input}: expected ${failure.expected}, got ${failure.actual}`)}`,
    );
  }
  if (check.failures.length > 5) lines.push(`    ${paint('dim', `… ${check.failures.length - 5} more`)}`);
  return lines;
}

function headerCells(group: GroupResult): Cell[] {
  const baseline = baselineLabel(group);
  const valueHeader = group.kind === 'size' ? 'size' : group.kind === 'metric' ? group.unit : 'time/op';
  return [
    { text: group.kind === 'scenario' ? 'case' : 'library', style: 'dim' },
    { text: 'version', style: 'dim' },
    { text: valueHeader, style: 'dim', align: 'right' },
    { text: '' },
    { text: group.kind === 'scenario' || !baseline ? '' : `vs ${baseline}`, style: 'dim' },
    { text: '' },
  ];
}

function singleSection(result: BenchResult, group: GroupResult, paint: Paint): string[] {
  const lines = [`${paint('bold', group.title)}  ${paint('dim', group.id)}`, ...contractLines(group, paint)];
  const max = Math.max(...group.cases.map(row => headline(row)));
  const rows: Cell[][] = [headerCells(group)];
  for (const row of group.cases) {
    const verdict =
      group.kind === 'scenario'
        ? undefined
        : verdictFor(group, row, { baselineText: '1.00× baseline', inconclusivePrefix: '? ' });
    rows.push([
      { text: row.label, style: row.role === 'baseline' ? 'bold' : undefined },
      { text: versionOf(result, row) ?? '', style: 'dim' },
      { text: estimateText(group, row), align: 'right' },
      { text: bar(headline(row), max), style: row.role === 'baseline' ? 'cyan' : 'dim' },
      { text: verdict?.text ?? '', style: verdict ? TONE_STYLE[verdict.tone] : undefined },
      { text: detailText(row), style: flagStyle(row) },
    ]);
  }
  lines.push(...table(rows, paint));
  if (group.kind === 'metric' && isDeterministic(group))
    lines.push(`  ${paint('dim', 'deterministic: measured once')}`);
  if (group.note) lines.push(`  ${paint('dim', group.note)}`);
  return lines;
}

function matrixSection(result: BenchResult, section: Extract<Section, { type: 'matrix' }>, paint: Paint): string[] {
  const { group, runtimes, perRuntime } = section;
  const lines = [`${paint('bold', group.title)}  ${paint('dim', group.id)}`];
  const failed = perRuntime.find(entry => entry?.check?.status === 'failed');
  lines.push(...contractLines(failed ?? perRuntime.find(Boolean) ?? group, paint));
  const header: Cell[] = [
    { text: group.kind === 'scenario' ? 'case' : 'library', style: 'dim' },
    { text: 'version', style: 'dim' },
    ...runtimes.map(runtime => ({ text: runtimeLabel(runtime), style: 'dim' as const })),
  ];
  const rows: Cell[][] = [header];
  for (const row of matrixRows(perRuntime)) {
    const cells: Cell[] = [
      { text: row.label, style: row.role === 'baseline' ? 'bold' : undefined },
      { text: versionOf(result, row) ?? '', style: 'dim' },
    ];
    for (const runtimeGroup of perRuntime) {
      const measured = runtimeGroup?.cases.find(entry => entry.key === row.key);
      if (!runtimeGroup || !measured) {
        cells.push({ text: '—', style: 'dim' });
        continue;
      }
      const verdict =
        runtimeGroup.kind === 'scenario'
          ? undefined
          : verdictFor(runtimeGroup, measured, { baselineText: '1.00×', inconclusivePrefix: '? ' });
      const flags = measured.flags.map(flag => flagText(flag));
      const text = [estimateText(runtimeGroup, measured), verdict?.text, ...flags].filter(Boolean).join('  ');
      cells.push({ text, style: verdict ? TONE_STYLE[verdict.tone] : undefined });
    }
    rows.push(cells);
  }
  lines.push(
    ...table(rows, paint),
    `  ${paint('dim', 'ratios compare cases within one runtime; columns are not comparable')}`,
  );
  if (group.note) lines.push(`  ${paint('dim', group.note)}`);
  return lines;
}

function headerLine(result: BenchResult): string {
  const runtimes =
    result.runtimes && result.runtimes.length > 0
      ? result.runtimes.map(runtime => runtimeLabel(runtime)).join(', ')
      : runtimeLabel(result);
  const git = result.environment.git;
  const parts = [
    runtimes,
    hostLabel(result),
    cpuLabel(result),
    profileLabel(result),
    `seed ${result.seed}`,
    git ? `rev ${git.revision.slice(0, 10)}${git.dirty ? ' (dirty)' : ''}` : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The terminal report for a run: header, one table per group, warnings, and a clear verdict on publishability. */
export function renderText(result: BenchResult, options: TextOptions = {}): string {
  const paint = painter(options.color ?? false);
  const lines: string[] = [
    `${paint('bold', result.suite.title)}  ${paint('dim', result.suite.id)}`,
    paint('dim', headerLine(result)),
  ];
  if (!result.publishable) lines.push(paint('redBold', 'NOT PUBLISHABLE — details at the end'));
  for (const section of sections(result)) {
    lines.push(
      '',
      ...(section.type === 'single'
        ? singleSection(result, section.group, paint)
        : matrixSection(result, section, paint)),
    );
  }
  if (allGroups(result).length === 0) lines.push('', paint('yellow', 'No groups ran (check --filter).'));
  if (result.warnings.length > 0 || !result.publishable) {
    lines.push('', result.publishable ? paint('yellow', 'Warnings') : paint('redBold', 'NOT PUBLISHABLE'));
    if (result.warnings.length === 0) lines.push(`  • ${result.profile} runs are never publishable`);
    for (const warning of result.warnings) {
      const where = [warning.group, warning.case].filter(Boolean).join('/');
      lines.push(`  • ${where ? `${where}: ` : ''}${warning.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
