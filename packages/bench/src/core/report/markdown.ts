/**
 * The README section, rendered deterministically from a saved result. It
 * states the contract, the versions and the environment next to every number,
 * never names a "fastest" case, and ends with a machine-readable meta line
 * that `arki-bench check` compares against the current suite.
 */
import type { BenchResult, CaseResult, GroupResult } from '../types.js';
import type { Section } from './format.js';
import {
  baselineLabel,
  cpuLabel,
  flagText,
  formatBytes,
  formatQuantity,
  formatSpread,
  hostLabel,
  isDeterministic,
  matrixRows,
  plural,
  profileLabel,
  rangeText,
  runtimeLabel,
  sections,
  verdictFor,
  versionOf,
} from './format.js';

export type MarkdownOptions = {
  /**
   * The reproduce line under the tables (Markdown). Default:
   * ``Reproduce: `bunx arki-bench run --profile publish` in the package directory.``
   * Pass an empty string to leave it out.
   */
  reproduce?: string;
};

export const DEFAULT_REPRODUCE = 'Reproduce: `bunx arki-bench run --profile publish` in the package directory.';

/** Text placed inside a table cell: pipes, backticks, `<` and newlines would break the table. */
export function escapeCell(text: string): string {
  return text
    .replaceAll(/\r?\n/g, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('`', '\\`')
    .replaceAll('<', '&lt;');
}

/** Author prose (intro, notes) stays Markdown, but may never open an HTML comment that would collide with the README markers. */
function prose(text: string): string {
  return text.replaceAll('<!--', '&lt;!--');
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function label(group: GroupResult, entry: CaseResult): string {
  const text = escapeCell(entry.label) + (entry.role === 'variant' ? ' (variant)' : '');
  return entry.role === 'baseline' && group.kind !== 'scenario' ? `**${text}**` : text;
}

function verdictCell(group: GroupResult, entry: CaseResult): string {
  const verdict = verdictFor(group, entry, { baselineText: 'baseline', inconclusivePrefix: '' });
  const flags = entry.flags.filter(flag => flag !== 'over-limit').map(flag => flagText(flag));
  return escapeCell([verdict?.text ?? '—', ...flags].join(' · '));
}

function contractSentence(group: GroupResult): string | undefined {
  if (group.kind !== 'compare' || !group.contract) return undefined;
  const sentence = `Every ranked row returns ${prose(group.contract.description)}`;
  const check = group.check;
  if (!check) return `${sentence}. The contract was not checked in this run.`;
  if (check.status === 'passed') return `${sentence}; checked on ${plural(check.inputs, 'input')}.`;
  const first = check.failures[0];
  const example = first
    ? ` First mismatch: ${escapeCell(first.case)} on input #${first.input} returned "${escapeCell(first.actual)}", expected "${escapeCell(first.expected)}".`
    : '';
  return `${sentence}. **Contract check failed:** ${plural(check.failures.length, 'mismatch', 'mismatches')} on ${plural(check.inputs, 'input')}.${example}`;
}

function caseHeader(group: GroupResult): string {
  return group.kind === 'scenario' ? 'Case' : 'Library';
}

function speedTable(result: BenchResult, group: GroupResult): string[] {
  const baseline = baselineLabel(group);
  const ranked = group.kind === 'compare' && baseline !== undefined;
  const deterministic = group.kind === 'metric' && isDeterministic(group);
  const valueHeader = group.kind === 'metric' ? escapeCell(group.unit) : 'Time / op';
  const header = [caseHeader(group), 'Version', valueHeader];
  if (!deterministic) header.push('95% interval');
  if (ranked || (group.kind === 'metric' && baseline)) header.push(`vs ${escapeCell(baseline)}`);
  const lines = [row(header), row(header.map((_, index) => (index === 2 ? '--:' : '---')))];
  for (const entry of group.cases) {
    const cells = [
      label(group, entry),
      escapeCell(versionOf(result, entry) ?? '—'),
      formatQuantity(entry.summary.estimate, group.unit),
    ];
    if (!deterministic) cells.push(rangeText(entry, group.unit));
    if (header.length > cells.length) cells.push(verdictCell(group, entry));
    lines.push(row(cells));
  }
  return lines;
}

function sizeTable(result: BenchResult, group: GroupResult): string[] {
  const baseline = baselineLabel(group);
  const budgets = group.cases.some(entry => entry.limit !== undefined);
  const header = ['Library', 'Version', 'JS+CSS gzip', 'brotli', 'raw'];
  if (budgets) header.push('Budget (gzip)');
  if (baseline) header.push(`vs ${escapeCell(baseline)}`);
  const lines = [row(header), row(header.map((_, index) => (index >= 2 && index <= 4 ? '--:' : '---')))];
  for (const entry of group.cases) {
    const size = entry.size;
    const cells = [
      label(group, entry),
      escapeCell(versionOf(result, entry) ?? '—'),
      size ? formatBytes(size.gzip) : '—',
      size ? formatBytes(size.brotli) : '—',
      size ? formatBytes(size.raw) : '—',
    ];
    if (budgets) {
      const over = entry.flags.includes('over-limit');
      cells.push(entry.limit === undefined ? '—' : `${formatBytes(entry.limit)}${over ? ' — **over budget**' : ''}`);
    }
    if (baseline) cells.push(verdictCell(group, entry));
    lines.push(row(cells));
  }
  return lines;
}

function groupIntro(group: GroupResult): string | undefined {
  if (group.kind === 'compare') return contractSentence(group);
  if (group.kind === 'scenario') return 'Each row measures different work; rows are not ranked.';
  if (group.kind === 'metric') {
    return isDeterministic(group)
      ? `Deterministic metric in ${prose(group.unit)}: measured once.`
      : `Repeated measurements in ${prose(group.unit)}, with 95% intervals.`;
  }
  return undefined;
}

function differsSentence(group: GroupResult): string | undefined {
  return group.cases.some(entry => entry.role === 'differs')
    ? 'Rows marked *different contract* do other work: they are measured and shown, never ranked.'
    : undefined;
}

function singleSection(result: BenchResult, group: GroupResult): string[] {
  const table = group.kind === 'size' ? sizeTable(result, group) : speedTable(result, group);
  const intro = [groupIntro(group), differsSentence(group)].filter(Boolean).join(' ');
  return [
    `### ${prose(group.title)}`,
    '',
    ...(intro ? [intro, ''] : []),
    ...table,
    ...(group.note ? ['', prose(group.note)] : []),
  ];
}

function matrixSection(result: BenchResult, section: Extract<Section, { type: 'matrix' }>): string[] {
  const { group, runtimes, perRuntime } = section;
  const failed = perRuntime.find(entry => entry?.check?.status === 'failed');
  const intro = [groupIntro(failed ?? perRuntime.find(Boolean) ?? group), differsSentence(group)]
    .filter(Boolean)
    .join(' ');
  const header = [caseHeader(group), 'Version', ...runtimes.map(runtime => escapeCell(runtimeLabel(runtime)))];
  const lines = [row(header), row(header.map(() => '---'))];
  for (const entry of matrixRows(perRuntime)) {
    const cells = [label(group, entry), escapeCell(versionOf(result, entry) ?? '—')];
    for (const runtimeGroup of perRuntime) {
      const measured = runtimeGroup?.cases.find(candidate => candidate.key === entry.key);
      if (!runtimeGroup || !measured) {
        cells.push('—');
        continue;
      }
      const value = formatQuantity(measured.summary.estimate, runtimeGroup.unit);
      const spread =
        measured.summary.interval[0] === measured.summary.interval[1]
          ? ''
          : ` ${formatSpread(measured.summary.estimate, measured.summary.interval)}`;
      const verdict = runtimeGroup.kind === 'scenario' ? '' : ` · ${verdictCell(runtimeGroup, measured)}`;
      cells.push(`${value}${spread}${verdict}`);
    }
    lines.push(row(cells));
  }
  return [
    `### ${prose(group.title)}`,
    '',
    ...(intro ? [intro, ''] : []),
    ...lines,
    '',
    'Ratios compare libraries within one runtime; the columns are not comparable to each other.',
    ...(group.note ? ['', prose(group.note)] : []),
  ];
}

function environmentLine(result: BenchResult): string {
  const env = result.environment;
  const runtimes =
    result.runtimes && result.runtimes.length > 0
      ? result.runtimes.map(runtime => runtimeLabel(runtime)).join(', ')
      : runtimeLabel(result);
  const machine = [hostLabel(result), cpuLabel(result)].filter(Boolean).join(', ');
  const parts = [
    `Measured on ${runtimes}${machine ? ` (${machine})` : ''}`,
    `@arki/bench ${env.harness.version} (mitata ${env.harness.mitata})`,
    `${profileLabel(result)}, seed ${result.seed}`,
    env.git ? `commit ${env.git.revision.slice(0, 10)}${env.git.dirty ? ' (uncommitted changes)' : ''}` : undefined,
    env.date.slice(0, 10),
  ];
  return `${parts
    .filter(Boolean)
    .map(part => escapeCell(part ?? ''))
    .join(' · ')}.`;
}

function versionsLine(result: BenchResult): string | undefined {
  const entries = Object.entries(result.packages).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  return `Versions: ${entries.map(([name, version]) => `${escapeCell(name)} ${escapeCell(version)}`).join(' · ')}.`;
}

function unpublishableBlock(result: BenchResult): string[] {
  if (result.publishable) return [];
  const reasons =
    result.warnings.length > 0
      ? result.warnings.map(warning => warning.message)
      : [`${result.profile} runs are never publishable.`];
  return [
    '> **Not publishable.** Do not quote these numbers:',
    '>',
    ...reasons.map(reason => `> - ${prose(reason)}`),
    '',
  ];
}

/**
 * The machine-readable line `arki-bench check` reads. `-->` can never appear
 * inside it: `>` after `--` is written as the JSON escape `\u003e`, which
 * JSON.parse reads back as `>`.
 */
export function metaComment(result: BenchResult): string {
  const meta = {
    schema: result.schema,
    suite: result.suite.id,
    specHash: result.suite.specHash,
    profile: result.profile,
    date: result.environment.date,
    harness: result.environment.harness.version,
  };
  return `<!-- bench:meta ${JSON.stringify(meta).replaceAll('-->', String.raw`--\u003e`)} -->`;
}

/** The README section for a result: heading, environment, one table per group, notes, reproduce line, meta line. */
export function renderMarkdown(result: BenchResult, options: MarkdownOptions = {}): string {
  const lines: string[] = [`## ${prose(result.suite.title)}`, '', ...unpublishableBlock(result)];
  if (result.suite.intro) lines.push(prose(result.suite.intro), '');
  lines.push(environmentLine(result));
  const versions = versionsLine(result);
  if (versions) lines.push('', versions);
  for (const section of sections(result)) {
    lines.push(
      '',
      ...(section.type === 'single' ? singleSection(result, section.group) : matrixSection(result, section)),
    );
  }
  if (result.suite.notes.length > 0) {
    lines.push('', '**Notes**', '', ...result.suite.notes.map(note => `- ${prose(note)}`));
  }
  const reproduce = options.reproduce ?? DEFAULT_REPRODUCE;
  if (reproduce) lines.push('', prose(reproduce));
  lines.push('', metaComment(result));
  return `${lines.join('\n')}\n`;
}
