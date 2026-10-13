/**
 * Renders the losses `collectLosses` found: an aligned text table for the
 * terminal, or Markdown for an issue or a PR. Competitors and variants get
 * their own sections. Pure string functions; never prints.
 */
import type { Loss } from '../types.js';
import { directionWords, factorDecimals, formatFactor, plural } from './format.js';
import { escapeCell } from './markdown.js';

export type LossesOptions = { format: 'text' | 'markdown' };

const SECTIONS = [
  { role: 'competitor', title: 'Competitors', blurb: 'a rival costs less than our library' },
  { role: 'variant', title: 'Variants', blurb: 'another way to call our own library costs less' },
] as const;

/** `3.2× slower [3.0–3.4]`: how much more the baseline costs, in the group's words; `(exact)` for sizes and deterministic metrics. */
export function lossVerdict(loss: Loss): string {
  const word = directionWords(loss.group.kind).higher;
  const [low, high] = loss.interval;
  const decimals = factorDecimals(loss.factor);
  const factor = formatFactor(loss.factor, decimals);
  if (low === high) return `${factor}× ${word} (exact)`;
  return `${factor}× ${word} [${formatFactor(low, decimals)}–${formatFactor(high, decimals)}]`;
}

function source(loss: Loss): string {
  return loss.publishable ? 'publishable' : `rough: ${loss.rough.join(' / ')}`;
}

function headline(losses: readonly Loss[]): string {
  const suites = new Set(losses.map(loss => loss.suite)).size;
  const rough = losses.filter(loss => !loss.publishable).length;
  const parts = [`${plural(losses.length, 'loss', 'losses')} in ${plural(suites, 'suite')}`];
  if (rough > 0) parts.push(`${rough} from rough results (not publishable)`);
  return parts.join(' · ');
}

const NONE = 'No losses: our library is never slower, larger or higher than another row in these results.\n';

function textTable(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(cells => cells[column]?.length ?? 0))) ?? [];
  return rows.map(cells => `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ')}`.trimEnd());
}

function renderText(losses: readonly Loss[]): string {
  const lines = [`Losses  ${headline(losses)}`];
  for (const section of SECTIONS) {
    const rows = losses.filter(loss => loss.role === section.role);
    if (rows.length === 0) continue;
    lines.push(
      '',
      `${section.title}: ${section.blurb}`,
      ...textTable([
        ['suite', 'runtime', 'group', 'ours', 'cheaper', 'ours is', 'source'],
        ...rows.map(loss => [
          loss.suite,
          loss.runtime,
          loss.group.id,
          loss.baseline,
          loss.case.label,
          lossVerdict(loss),
          source(loss),
        ]),
      ]),
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(losses: readonly Loss[]): string {
  const lines = ['## Benchmark losses', '', `${headline(losses)}.`];
  for (const section of SECTIONS) {
    const rows = losses.filter(loss => loss.role === section.role);
    if (rows.length === 0) continue;
    lines.push(
      '',
      `### ${section.title}`,
      '',
      `Rows where ${section.blurb}.`,
      '',
      '| Suite | Runtime | Group | Ours | Cheaper | Ours is | Source |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(loss => {
        const cells = [
          loss.suite,
          loss.runtime,
          `${loss.group.title} · ${loss.group.id}`,
          loss.baseline,
          loss.case.label,
          lossVerdict(loss),
        ].map(cell => escapeCell(cell));
        cells.push(loss.publishable ? 'publishable' : `**rough:** ${escapeCell(loss.rough.join(' / '))}`);
        return `| ${cells.join(' | ')} |`;
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The losses as a text table (terminal) or Markdown (an issue or a PR), worst
 * first, competitors and variants in separate sections. Each row says how
 * many times the other row the baseline costs, in the group's words (slower,
 * larger, higher), and marks rows from a result that is not publishable as
 * rough, with the reasons.
 */
export function renderLosses(losses: readonly Loss[], options: LossesOptions): string {
  if (losses.length === 0) return options.format === 'markdown' ? `## Benchmark losses\n\n${NONE}` : NONE;
  return options.format === 'markdown' ? renderMarkdown(losses) : renderText(losses);
}
