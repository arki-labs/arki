/**
 * Losses: where the suite's own library costs more than another row, across
 * any number of saved results. Pure and portable.
 */
import type { BenchResult, CaseResult, GroupResult, Loss } from './types.js';
import { comparisonBlocks, MIN_COMPARISON_BLOCKS } from './stats.js';
import { BLOCKING_WARNINGS } from './warnings.js';

/** The blocking warnings of a non-publishable result, in words (`quick-profile` → `quick profile`). */
function roughReasons(result: BenchResult): readonly string[] {
  if (result.publishable) return [];
  const codes = new Set(result.warnings.map(warning => warning.code));
  const words = BLOCKING_WARNINGS.filter(code => codes.has(code)).map(code => code.replaceAll('-', ' '));
  return words.length > 0 ? words : ['not publishable'];
}

/**
 * The group's baseline row when it is the suite's own library: its package is
 * the suite id, or it names no package (local code, as in a suite that
 * benchmarks its own source).
 */
function ownBaseline(suite: string, group: GroupResult): CaseResult | undefined {
  const base = group.cases.find(entry => entry.key === group.baseline);
  if (base?.role !== 'baseline') return undefined;
  return base.package === undefined || base.package === suite ? base : undefined;
}

function groupLosses(result: BenchResult, part: BenchResult, group: GroupResult, rough: readonly string[]): Loss[] {
  const baseline = ownBaseline(result.suite.id, group);
  if (!baseline) return [];
  const losses: Loss[] = [];
  for (const comparison of group.comparisons) {
    if (comparison.verdict !== 'lower') continue;
    const other = group.cases.find(entry => entry.key === comparison.case);
    // `differs` rows do other work and are never ranked; a baseline never compares with itself.
    if (other?.role !== 'competitor' && other?.role !== 'variant') continue;
    // A sampled comparison on one block has no interval, whatever an older result recorded.
    const blocks = comparisonBlocks(group, other.key);
    if (blocks !== undefined && blocks < MIN_COMPARISON_BLOCKS) continue;
    const [low, high] = comparison.interval;
    losses.push({
      suite: result.suite.id,
      runtime: part.environment.runtime.name,
      group: { id: group.id, title: group.title, kind: group.kind },
      baseline: baseline.label,
      case: { key: other.key, label: other.label },
      role: other.role,
      factor: 1 / comparison.ratio,
      interval: [1 / high, 1 / low],
      publishable: result.publishable,
      rough,
    });
  }
  return losses;
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function worstFirst(a: Loss, b: Loss): number {
  return (
    b.factor - a.factor ||
    order(a.suite, b.suite) ||
    order(a.runtime, b.runtime) ||
    order(a.group.id, b.group.id) ||
    order(a.case.key, b.case.key)
  );
}

/**
 * Every place where the suite's own library costs more than another row:
 * a comparison with verdict `lower` (the other row is faster, smaller or
 * lower) in a group whose baseline is the suite's library. `differs` rows,
 * ties, inconclusive rows and sampled comparisons on fewer than
 * `MIN_COMPARISON_BLOCKS` blocks never count. A runtime matrix is read per
 * runtime (size groups once: bundling does not depend on the runtime).
 * Sorted worst first (largest factor), then by suite, runtime, group, case.
 */
export function collectLosses(results: readonly BenchResult[]): Loss[] {
  const losses: Loss[] = [];
  for (const result of results) {
    const rough = roughReasons(result);
    const parts = result.runtimes && result.runtimes.length > 0 ? result.runtimes : [result];
    for (const [index, part] of parts.entries()) {
      for (const group of part.groups) {
        if (index > 0 && group.kind === 'size') continue;
        losses.push(...groupLosses(result, part, group, rough));
      }
    }
  }
  return losses.sort(worstFirst);
}
