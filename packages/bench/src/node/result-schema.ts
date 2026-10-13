/**
 * Validates a saved result (schema 1) before `report`, `compare` or a host
 * reads it: the full structure, numeric domains, interval order, unique group
 * ids and case keys. A hand-edited or truncated file fails with the first bad
 * path instead of rendering nonsense or crashing deep in a renderer.
 *
 * Host-only (zod is a dependency of the Node host, never of the portable core).
 */
import { z } from 'zod';

import type { BenchResult } from '../core/types.js';

const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const count = z.number().int().nonnegative();

const interval = z
  .tuple([nonNegative, nonNegative])
  .refine(([low, high]) => low <= high, { message: 'interval low is above high' });

const summary = z
  .object({
    estimate: nonNegative,
    interval,
    median: nonNegative,
    min: nonNegative,
    max: nonNegative,
    p75: nonNegative,
    p99: nonNegative,
    cv: nonNegative,
    n: z.number().int().positive(),
  })
  .refine(value => value.min <= value.max, { message: 'min is above max', path: ['min'] });

const block = z.object({
  process: count,
  block: count,
  ns: nonNegative,
  ops: finite.positive(),
});

const fileSize = z.object({ path: z.string(), raw: count, gzip: count, brotli: count });

const caseResult = z.object({
  key: z.string().min(1),
  label: z.string(),
  package: z.string().optional(),
  role: z.enum(['baseline', 'competitor', 'variant', 'differs']),
  differs: z.string().optional(),
  workHash: z.string().optional(),
  summary,
  blocks: z.array(block).optional(),
  gc: z.object({ total: nonNegative, avg: nonNegative }).optional(),
  heap: z.object({ avg: nonNegative }).optional(),
  size: z
    .object({
      raw: count,
      gzip: count,
      brotli: count,
      files: z.array(fileSize),
      contributors: z.array(z.object({ path: z.string(), bytes: count })).optional(),
    })
    .optional(),
  limit: count.optional(),
  flags: z.array(z.enum(['optimized-out', 'unstable', 'over-limit'])),
});

const comparison = z.object({
  case: z.string().min(1),
  ratio: nonNegative,
  interval,
  verdict: z.enum(['lower', 'higher', 'tie', 'inconclusive']),
});

const contract = z.object({ id: z.string().min(1), description: z.string() });

const warning = z.object({
  code: z.string().min(1),
  message: z.string(),
  group: z.string().optional(),
  case: z.string().optional(),
  runtime: z.enum(['node', 'bun', 'deno', 'browser', 'hermes', 'unknown']).optional(),
});

const groupResult = z
  .object({
    kind: z.enum(['compare', 'scenario', 'size', 'metric']),
    id: z.string().min(1),
    title: z.string(),
    note: z.string().optional(),
    unit: z.string(),
    contract: contract.optional(),
    specHash: z.string().optional(),
    deterministic: z.boolean().optional(),
    check: z
      .object({
        status: z.enum(['passed', 'failed']),
        inputs: count,
        failures: z.array(z.object({ case: z.string(), input: count, expected: z.string(), actual: z.string() })),
      })
      .optional(),
    baseline: z.string().optional(),
    floor: summary.optional(),
    floorBlocks: z.array(block).optional(),
    cases: z.array(caseResult),
    comparisons: z.array(comparison),
    warnings: z.array(warning).optional(),
  })
  .superRefine((group, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of group.cases.entries()) {
      if (keys.has(entry.key)) {
        context.addIssue({
          code: 'custom',
          message: `case key "${entry.key}" is used twice`,
          path: ['cases', index, 'key'],
        });
      }
      keys.add(entry.key);
    }
  });

const environment = z.object({
  runtime: z.object({
    name: z.enum(['node', 'bun', 'deno', 'browser', 'hermes', 'unknown']),
    version: z.string(),
  }),
  os: z.string().optional(),
  arch: z.string().optional(),
  cpu: z.string().optional(),
  cores: z.number().int().positive().optional(),
  flags: z.array(z.string()),
  harness: z.object({ version: z.string(), mitata: z.string() }),
  git: z.object({ revision: z.string(), dirty: z.boolean() }).optional(),
  load: z.tuple([nonNegative, nonNegative]).optional(),
  date: z.string(),
});

type ResultShape = z.ZodType<BenchResult>;

const benchResult: ResultShape = z.lazy(() =>
  z
    .object({
      schema: z.literal(1),
      suite: z.object({
        id: z.string().min(1),
        title: z.string(),
        intro: z.string().optional(),
        notes: z.array(z.string()),
        specHash: z.string(),
      }),
      profile: z.enum(['quick', 'explore', 'publish']),
      seed: z.number().int().nonnegative(),
      publishable: z.boolean(),
      warnings: z.array(warning),
      environment,
      packages: z.record(z.string(), z.string()),
      groups: z.array(groupResult),
      runtimes: z.array(benchResult).optional(),
    })
    .superRefine((result, context) => {
      const ids = new Set<string>();
      for (const [index, group] of result.groups.entries()) {
        if (ids.has(group.id)) {
          context.addIssue({
            code: 'custom',
            message: `group id "${group.id}" is used twice`,
            path: ['groups', index, 'id'],
          });
        }
        ids.add(group.id);
      }
    }),
);

function formatPath(path: readonly PropertyKey[]): string {
  let text = '';
  for (const part of path) {
    text += typeof part === 'number' ? `[${part}]` : `${text === '' ? '' : '.'}${String(part)}`;
  }
  return text === '' ? '(root)' : text;
}

/** A saved result that does not match schema 1. */
export class ResultError extends Error {
  override name = 'ResultError';
}

/**
 * Checks that `value` (parsed JSON from `source`) is a schema-1 BenchResult
 * and returns it typed. Throws a `ResultError` naming the source, the first
 * bad path and what is wrong there.
 */
export function parseResult(value: unknown, source: string): BenchResult {
  if (typeof value === 'object' && value !== null && 'schema' in value && value.schema !== 1) {
    throw new ResultError(`${source} uses result schema ${String(value.schema)}; this arki-bench reads schema 1.`);
  }
  if (typeof value !== 'object' || value === null || !('schema' in value)) {
    throw new ResultError(`${source} is not an arki-bench result (no "schema" field).`);
  }
  const parsed = benchResult.safeParse(value);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const where = issue ? formatPath(issue.path) : '(root)';
  throw new ResultError(
    `${source} is not a valid schema-1 result: at ${where}: ${issue?.message ?? 'invalid'}${parsed.error.issues.length > 1 ? ` (and ${parsed.error.issues.length - 1} more problem(s))` : ''}.`,
  );
}
