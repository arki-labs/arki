/**
 * Shared formatting for the renderers: units, intervals, verdict words and the
 * environment line. Pure string functions; no host APIs.
 */
import type { BenchResult, CaseResult, Comparison, GroupResult, Interval } from '../types.js';
import { comparisonBlocks, MIN_COMPARISON_BLOCKS } from '../stats.js';

/** Rounds to `digits` significant digits without switching to exponent notation for normal values. */
export function significant(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  if (Math.abs(value) >= 10 ** digits) return groupThousands(Math.round(value));
  return String(Number(value.toPrecision(digits)));
}

function groupThousands(value: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(value)).replaceAll(/\B(?=(?:\d{3})+(?!\d))/g, ',');
}

type Scale = readonly (readonly [factor: number, unit: string])[];

const TIME: Scale = [
  [1, 'ns'],
  [1e3, 'µs'],
  [1e6, 'ms'],
  [1e9, 's'],
];
const BYTES: Scale = [
  [1, 'B'],
  [1e3, 'kB'],
  [1e6, 'MB'],
];

/** Picks the largest unit whose rounded value stays below 1000 of the next unit. */
function scaled(value: number, scale: Scale): { number: string; unit: string } {
  let chosen = scale[0] ?? ([1, ''] as const);
  for (const step of scale) {
    if (Math.abs(value) >= step[0] * 0.9995) chosen = step;
  }
  return { number: significant(value / chosen[0]), unit: chosen[1] };
}

const isTimeUnit = (unit: string | undefined): boolean => unit === 'ns' || unit === 'ns/op';
const isByteUnit = (unit: string | undefined): boolean => unit === 'B' || unit === 'byte' || unit === 'bytes';

function scaleFor(unit: string | undefined): Scale | undefined {
  if (isTimeUnit(unit)) return TIME;
  if (isByteUnit(unit)) return BYTES;
  return undefined;
}

export function formatTime(ns: number): string {
  const { number, unit } = scaled(ns, TIME);
  return `${number} ${unit}`;
}

export function formatBytes(bytes: number): string {
  const { number, unit } = scaled(bytes, BYTES);
  return `${number} ${unit}`;
}

/** Formats a value in a group's unit: time for `ns`, bytes for `B`, otherwise the number plus the unit label. */
export function formatQuantity(value: number, unit?: string): string {
  const scale = scaleFor(unit);
  if (scale) {
    const { number, unit: label } = scaled(value, scale);
    return `${number} ${label}`;
  }
  return unit ? `${significant(value)} ${unit}` : significant(value);
}

/** `400–425 ns` when both ends share a unit, `980 ns–1.02 µs` otherwise. */
export function formatRange(interval: Interval, unit?: string): string {
  const scale = scaleFor(unit);
  if (!scale) {
    const range = `${significant(interval[0])}–${significant(interval[1])}`;
    return unit ? `${range} ${unit}` : range;
  }
  const low = scaled(interval[0], scale);
  const high = scaled(interval[1], scale);
  if (low.unit === high.unit) return `${low.number}–${high.number} ${high.unit}`;
  return `${low.number} ${low.unit}–${high.number} ${high.unit}`;
}

/** Half the interval width relative to the estimate: `±3%`. */
export function formatSpread(estimate: number, interval: Interval): string {
  if (estimate === 0 || interval[0] === interval[1]) return '±0%';
  const percent = ((interval[1] - interval[0]) / 2 / Math.abs(estimate)) * 100;
  if (percent >= 1) return `±${Math.round(percent)}%`;
  return `±${percent.toFixed(1)}%`;
}

/** Decimals for a ratio factor: `1.06`, `3.2`, `12`. */
export function factorDecimals(factor: number): number {
  if (factor >= 10) return 0;
  if (factor >= 1.1) return 1;
  return 2;
}

export function formatFactor(factor: number, decimals = factorDecimals(factor)): string {
  return factor.toFixed(decimals);
}

/** Words for "lower" and "higher" per group kind. Every recorded metric is lower-is-better. */
export function directionWords(kind: GroupResult['kind']): { lower: string; higher: string } {
  if (kind === 'size') return { lower: 'smaller', higher: 'larger' };
  if (kind === 'metric') return { lower: 'lower', higher: 'higher' };
  return { lower: 'faster', higher: 'slower' };
}

export type Tone = 'baseline' | 'good' | 'bad' | 'neutral' | 'unknown' | 'muted';

export type Verdict = { text: string; tone: Tone };

/**
 * The comparison cell for one row. Ranked rows get a factor with its interval;
 * a tie is `≈ same`; an unestablished difference is `inconclusive`, never a winner.
 */
export function verdictFor(
  group: GroupResult,
  row: CaseResult,
  options: { baselineText: string; inconclusivePrefix: string },
): Verdict | undefined {
  if (row.role === 'differs') return { text: `different contract: ${row.differs ?? 'not declared'}`, tone: 'muted' };
  if (row.role === 'baseline') return { text: options.baselineText, tone: 'baseline' };
  const comparison = group.comparisons.find(entry => entry.case === row.key);
  if (!comparison) return undefined;
  return describeComparison(group.kind, comparison, options.inconclusivePrefix, comparisonBlocks(group, row.key));
}

/**
 * `blocks`: the thinner side's block count for a sampled comparison (see
 * `comparisonBlocks`). Below `MIN_COMPARISON_BLOCKS` the row is
 * `inconclusive (1 block)`, never a factor with a `[x–x]` interval, even when
 * an older result recorded a verdict for it.
 */
export function describeComparison(
  kind: GroupResult['kind'],
  comparison: Comparison,
  inconclusivePrefix: string,
  blocks?: number,
): Verdict {
  const words = directionWords(kind);
  const [low, high] = comparison.interval;
  if (blocks !== undefined && blocks < MIN_COMPARISON_BLOCKS) {
    return { text: `${inconclusivePrefix}inconclusive (${plural(blocks, 'block')})`, tone: 'unknown' };
  }
  if (comparison.verdict === 'tie') return { text: '≈ same', tone: 'neutral' };
  if (comparison.verdict === 'inconclusive') {
    const decimals = 2;
    return {
      text: `${inconclusivePrefix}inconclusive [${formatFactor(low, decimals)}–${formatFactor(high, decimals)}×]`,
      tone: 'unknown',
    };
  }
  if (comparison.verdict === 'higher') {
    const decimals = factorDecimals(comparison.ratio);
    return {
      text: `${formatFactor(comparison.ratio, decimals)}× ${words.higher} [${formatFactor(low, decimals)}–${formatFactor(high, decimals)}]`,
      tone: 'bad',
    };
  }
  // lower: show the factor baseline / case (the speed-up, for time), with the interval inverted to match.
  const factor = 1 / comparison.ratio;
  const decimals = factorDecimals(factor);
  return {
    text: `${formatFactor(factor, decimals)}× ${words.lower} [${formatFactor(1 / high, decimals)}–${formatFactor(1 / low, decimals)}]`,
    tone: 'good',
  };
}

const FLAG_TEXT: Readonly<Record<CaseResult['flags'][number], string>> = {
  'optimized-out': '⚠ optimized out',
  unstable: '⚠ unstable',
  'over-limit': 'over budget',
};

export function flagText(flag: CaseResult['flags'][number]): string {
  return FLAG_TEXT[flag];
}

const RUNTIME_NAMES: Readonly<Record<BenchResult['environment']['runtime']['name'], string>> = {
  node: 'Node',
  bun: 'Bun',
  deno: 'Deno',
  browser: 'Browser',
  hermes: 'Hermes',
  unknown: 'Unknown runtime',
};

export function runtimeLabel(result: BenchResult): string {
  const { name, version } = result.environment.runtime;
  return version ? `${RUNTIME_NAMES[name]} ${version}` : RUNTIME_NAMES[name];
}

export function hostLabel(result: BenchResult): string | undefined {
  const { os, arch } = result.environment;
  const parts = [os, arch].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function cpuLabel(result: BenchResult): string | undefined {
  const { cpu, cores } = result.environment;
  if (!cpu) return cores ? `${cores} cores` : undefined;
  return cores ? `${cpu} (${cores} cores)` : cpu;
}

/** `publish · 5 processes × 10 blocks`, read from the recorded blocks (or the block count when samples were dropped). */
export function profileLabel(result: BenchResult): string {
  const timed = allGroups(result)
    .filter(group => group.kind === 'compare' || group.kind === 'scenario')
    .flatMap(group => group.cases);
  const withBlocks = timed.find(row => row.blocks && row.blocks.length > 0);
  if (withBlocks?.blocks) {
    const processes = new Set(withBlocks.blocks.map(block => block.process)).size;
    const perProcess = Math.round(withBlocks.blocks.length / processes);
    return `${result.profile} · ${plural(processes, 'process', 'processes')} × ${plural(perProcess, 'block')}`;
  }
  const first = timed[0];
  return first ? `${result.profile} · ${plural(first.summary.n, 'block')}` : result.profile;
}

/** `1 input`, `12 inputs`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Every group in the result, including those that only exist inside runtime results. */
export function allGroups(result: BenchResult): readonly GroupResult[] {
  return [...result.groups, ...(result.runtimes ?? []).flatMap(runtime => runtime.groups)];
}

export function versionOf(result: BenchResult, row: CaseResult): string | undefined {
  const name = row.package;
  if (!name) return undefined;
  return result.packages[name] ?? result.runtimes?.map(runtime => runtime.packages[name]).find(Boolean);
}

/** The headline number of a row: gzip bytes for size rows, the summary estimate otherwise. */
export function headline(row: CaseResult): number {
  return row.size === undefined ? row.summary.estimate : row.size.gzip;
}

/**
 * The 95% interval of a row's estimate, or `1 block` when fewer than
 * `MIN_COMPARISON_BLOCKS` blocks (or observations) stand behind it: one block
 * has no interval, and `[x–x]` would read as a measured one.
 */
export function rangeText(row: CaseResult, unit?: string): string {
  if (row.summary.n < MIN_COMPARISON_BLOCKS) return plural(row.summary.n, 'block');
  return formatRange(row.summary.interval, unit);
}

/** A deterministic metric group (collected once). Decided by the spec, never by zero spread. */
export function isDeterministic(group: GroupResult): boolean {
  return group.kind === 'metric' && group.deterministic === true;
}

/**
 * A page section: one group, or one group measured on several runtimes
 * (runtime matrix). Size groups do not depend on the runtime and stay single.
 */
export type Section =
  | { type: 'single'; group: GroupResult }
  | {
      type: 'matrix';
      group: GroupResult;
      runtimes: readonly BenchResult[];
      perRuntime: readonly (GroupResult | undefined)[];
    };

export function sections(result: BenchResult): readonly Section[] {
  const runtimes = result.runtimes ?? [];
  if (runtimes.length === 0) return result.groups.map(group => ({ type: 'single', group }));
  const order: GroupResult[] = [];
  const seen = new Set<string>();
  for (const group of [...runtimes.flatMap(runtime => runtime.groups), ...result.groups]) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    order.push(group);
  }
  return order.map((group): Section => {
    const perRuntime = runtimes.map(runtime => runtime.groups.find(entry => entry.id === group.id));
    if (group.kind === 'size' || perRuntime.every(entry => entry === undefined)) return { type: 'single', group };
    return { type: 'matrix', group, runtimes, perRuntime };
  });
}

/** Case keys across every runtime, in first-seen order. */
export function matrixRows(perRuntime: readonly (GroupResult | undefined)[]): readonly CaseResult[] {
  const rows: CaseResult[] = [];
  const seen = new Set<string>();
  for (const group of perRuntime) {
    for (const row of group?.cases ?? []) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
    }
  }
  return rows;
}

export function baselineLabel(group: GroupResult): string | undefined {
  if (!group.baseline) return undefined;
  return group.cases.find(row => row.key === group.baseline)?.label ?? group.baseline;
}

export function formatThreshold(threshold: number): string {
  return `${Number((threshold * 100).toPrecision(3))}%`;
}

export function formatPercentChange(ratio: number): string {
  const percent = (ratio - 1) * 100;
  const magnitude = Math.abs(percent).toFixed(Math.abs(percent) >= 10 ? 0 : 1);
  if (Number(magnitude) === 0) return `${magnitude}%`;
  return `${percent > 0 ? '+' : '-'}${magnitude}%`;
}
