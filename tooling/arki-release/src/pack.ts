/**
 * Pack auditor — runs `npm pack --dry-run --json` against a candidate
 * package and validates the planned tarball contents against a fixed
 * rule set.
 *
 * Two halves:
 *   - {@link runNpmPack} spawns the npm CLI and parses its JSON output.
 *     The runner is injectable so tests don't have to actually spawn
 *     npm (which would be slow and brittle).
 *   - {@link auditPack} applies the {@link DEFAULT_PACK_RULES} to the
 *     parsed pack output and returns a {@link PackAuditResult}.
 *
 * The two halves compose, but they're separable: a Task 5 / Task 8 caller
 * can audit a synthetic pack entry without spawning npm.
 *
 * Stable error codes for envelope use:
 *   - `PACK_E001` — npm pack invocation failed.
 *   - `PACK_E002` — npm pack output did not parse as expected JSON.
 *   - `PACK_E003` — a pack-audit rule flagged a failure.
 */

import debugFactory from 'debug';

import type {
  NpmPackEntry,
  NpmPackFileEntry,
  PackAuditContext,
  PackAuditResult,
  PackAuditRule,
} from './types';

const debug = debugFactory('arki:release:pack');

/** Stable error codes for pack-audit envelope entries. */
export const PACK_ERROR_CODES = {
  packInvocationFailed: 'PACK_E001',
  packOutputUnparseable: 'PACK_E002',
  packAuditRuleFailed: 'PACK_E003',
} as const;

/**
 * Default pack-audit rules.
 *
 * Severity guidance:
 *   - `error`  — publication-blocking shape violations (tests in
 *     published files, raw .ts when not source-distributed, missing
 *     compiled artifacts, missing types, .env / node_modules leaks).
 *   - `warning` — soft hygiene flags (oversized files, missing README,
 *     missing LICENSE). These appear in the report but don't gate.
 */
export const DEFAULT_PACK_RULES: readonly PackAuditRule[] = [
  {
    id: 'no-tests',
    description: 'Forbids test files in published output.',
    severity: 'error',
    check: entry => {
      const offender = entry.files.find(f => /\.test\.|\.spec\.|__tests__\/|\/tests?\//i.test(f.path));
      return offender ? `test file in published output: ${offender.path}` : null;
    },
  },
  {
    id: 'no-private-docs',
    description: 'Forbids docs/internal/ or docs/private/ entries in published output.',
    severity: 'error',
    check: entry => {
      const offender = entry.files.find(f => /^docs\/(internal|private)\//i.test(f.path));
      return offender ? `private docs in published output: ${offender.path}` : null;
    },
  },
  {
    id: 'no-raw-ts',
    description: 'Forbids raw TypeScript source in published output unless the package is source-distributed.',
    severity: 'error',
    check: (entry, ctx) => {
      if (ctx.isSourceDistributed) return null;
      const offender = entry.files.find(
        f => /\.(ts|tsx|mts|cts)$/i.test(f.path) && !/\.d\.(ts|mts|cts)$/i.test(f.path),
      );
      return offender ? `raw TypeScript source in published output: ${offender.path}` : null;
    },
  },
  {
    id: 'requires-compiled',
    description: 'Requires at least one compiled JavaScript artifact unless the package is source-distributed.',
    severity: 'error',
    check: (entry, ctx) => {
      if (ctx.isSourceDistributed) return null;
      const hasCompiled = entry.files.some(f => /\.(js|mjs|cjs)$/i.test(f.path));
      return hasCompiled ? null : 'no compiled JavaScript (.js/.mjs/.cjs) in published output';
    },
  },
  {
    id: 'requires-declarations',
    description: 'Requires at least one TypeScript declaration file in published output.',
    severity: 'error',
    check: entry => {
      const hasDts = entry.files.some(f => /\.d\.(ts|mts|cts)$/i.test(f.path));
      return hasDts ? null : 'no TypeScript declarations (.d.ts) in published output';
    },
  },
  {
    id: 'no-env-files',
    description: 'Forbids `.env` or `.env.*` files in published output.',
    severity: 'error',
    check: entry => {
      const offender = entry.files.find(f => /(^|\/)\.env(\.|$)/i.test(f.path));
      return offender ? `env file in published output: ${offender.path}` : null;
    },
  },
  {
    id: 'no-node-modules',
    description: 'Forbids any `node_modules/` segment in published output.',
    severity: 'error',
    check: entry => {
      const offender = entry.files.find(f => /(^|\/)node_modules\//.test(f.path));
      return offender ? `node_modules leak in published output: ${offender.path}` : null;
    },
  },
  {
    id: 'no-large-files',
    description: 'Warns when any published file exceeds 1MB.',
    severity: 'warning',
    check: entry => {
      const offender = entry.files.find(f => f.size > 1_000_000);
      return offender ? `oversized file (>1MB) in published output: ${offender.path} (${offender.size.toString()} bytes)` : null;
    },
  },
  {
    id: 'requires-readme',
    description: 'Warns when no README.md is included in published output.',
    severity: 'warning',
    check: entry => {
      const hasReadme = entry.files.some(f => /(^|\/)readme(\.md)?$/i.test(f.path));
      return hasReadme ? null : 'no README.md in published output';
    },
  },
  {
    id: 'requires-license',
    description: 'Warns when no LICENSE file is included in published output.',
    severity: 'warning',
    check: entry => {
      const hasLicense = entry.files.some(f => /(^|\/)license(\.|$)/i.test(f.path));
      return hasLicense ? null : 'no LICENSE file in published output';
    },
  },
];

/**
 * Discriminated union returned by {@link runNpmPack}.
 *
 * Using a tagged union (instead of throwing) lets the CLI handler convert
 * a failed invocation into a structured envelope error without try/catch
 * gymnastics.
 */
export type NpmPackResult =
  | { readonly ok: true; readonly entries: readonly NpmPackEntry[] }
  | { readonly ok: false; readonly error: string };

/** Result of invoking the underlying npm process. */
export interface NpmPackRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** A runner callback — injectable so tests don't spawn real npm. */
export type NpmPackRunner = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<NpmPackRunOutput>;

/**
 * Default runner that shells out to `npm`. Uses `Bun.spawn` for native
 * Bun parity. Tests inject a fake runner.
 *
 * Captures both stdout and stderr; the auditor surfaces stderr as part
 * of the failure reason if the JSON parse fails.
 */
const defaultRunner: NpmPackRunner = async (args, { cwd }) => {
  const proc = Bun.spawn(['npm', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
};

/**
 * Run `npm pack --dry-run --json` in the given package directory and
 * parse the result.
 *
 * `--dry-run` ensures no tarball is written to disk. `--json` makes npm
 * emit an array of {@link NpmPackEntry}.
 *
 * Inject `runner` in tests; production omits it and uses
 * {@link defaultRunner} which invokes the real npm CLI.
 */
export async function runNpmPack(
  packageDir: string,
  options?: { readonly runner?: NpmPackRunner },
): Promise<NpmPackResult> {
  const runner = options?.runner ?? defaultRunner;
  debug('runNpmPack: cwd=%s', packageDir);
  let output: NpmPackRunOutput;
  try {
    output = await runner(['pack', '--dry-run', '--json'], { cwd: packageDir });
  } catch (cause) {
    return {
      ok: false,
      error: `npm pack invocation threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (output.code !== 0) {
    return {
      ok: false,
      error: `npm pack exited with code ${output.code.toString()}: ${output.stderr.trim() || output.stdout.trim() || '(no output)'}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout) as unknown;
  } catch (cause) {
    return {
      ok: false,
      error: `npm pack output is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const validated = validateNpmPackOutput(parsed);
  if (!validated.ok) return validated;
  return { ok: true, entries: validated.entries };
}

/**
 * Validate that the parsed npm pack output is an array of entries with
 * the fields we depend on. Returns a typed result.
 */
function validateNpmPackOutput(raw: unknown): NpmPackResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'npm pack output is not an array' };
  }
  const entries: NpmPackEntry[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, error: 'npm pack entry is not an object' };
    }
    const e = entry as Record<string, unknown>;
    const name = e['name'];
    const version = e['version'];
    const filename = e['filename'];
    const id = e['id'];
    const files = e['files'];
    const entryCount = e['entryCount'];
    const size = e['size'];
    const unpackedSize = e['unpackedSize'];
    const bundled = e['bundled'] ?? [];

    if (typeof name !== 'string' || typeof version !== 'string') {
      return { ok: false, error: 'npm pack entry missing name/version' };
    }
    if (!Array.isArray(files)) {
      return { ok: false, error: `npm pack entry ${name} missing files[]` };
    }

    const fileEntries: NpmPackFileEntry[] = [];
    for (const f of files) {
      if (f === null || typeof f !== 'object') continue;
      const fr = f as Record<string, unknown>;
      const fpath = fr['path'];
      const fsize = fr['size'];
      const fmode = fr['mode'];
      if (typeof fpath !== 'string' || typeof fsize !== 'number') continue;
      fileEntries.push({
        path: fpath,
        size: fsize,
        mode: typeof fmode === 'number' ? fmode : 0,
      });
    }

    entries.push({
      id: typeof id === 'string' ? id : `${name}@${version}`,
      name,
      version,
      filename: typeof filename === 'string' ? filename : `${name}-${version}.tgz`,
      files: fileEntries,
      entryCount: typeof entryCount === 'number' ? entryCount : fileEntries.length,
      bundled: Array.isArray(bundled) ? bundled.filter((b): b is string => typeof b === 'string') : [],
      size: typeof size === 'number' ? size : 0,
      unpackedSize: typeof unpackedSize === 'number' ? unpackedSize : 0,
      shasum: typeof e['shasum'] === 'string' ? (e['shasum'] as string) : undefined,
      integrity: typeof e['integrity'] === 'string' ? (e['integrity'] as string) : undefined,
    });
  }
  return { ok: true, entries };
}

/**
 * Apply the rule set to a single npm pack entry and produce a
 * {@link PackAuditResult}. Pure — no I/O.
 *
 * Status mapping:
 *   - At least one `error` hit  → `fail`
 *   - Only `warning` hits        → `warn`
 *   - No hits                    → `pass`
 */
export function auditPackEntry(
  entry: NpmPackEntry,
  context: PackAuditContext,
  rules: readonly PackAuditRule[] = DEFAULT_PACK_RULES,
): PackAuditResult {
  const ruleHits: Array<{
    ruleId: string;
    severity: 'error' | 'warning';
    description: string;
    reason: string;
  }> = [];

  for (const rule of rules) {
    const reason = rule.check(entry, context);
    if (reason !== null) {
      ruleHits.push({
        ruleId: rule.id,
        severity: rule.severity,
        description: rule.description,
        reason,
      });
    }
  }

  const hasError = ruleHits.some(h => h.severity === 'error');
  const hasWarning = ruleHits.some(h => h.severity === 'warning');
  const status: PackAuditResult['status'] = hasError ? 'fail' : hasWarning ? 'warn' : 'pass';

  return {
    package: { name: entry.name, version: entry.version },
    status,
    ruleHits,
    totals: {
      fileCount: entry.files.length,
      unpackedSize: entry.unpackedSize,
      packedSize: entry.size,
    },
  };
}

/**
 * Higher-level helper: invoke npm pack on a package dir AND run the
 * audit rules over the result. Returns a typed union; the CLI handler
 * maps it to envelope entries.
 *
 * `runner` is injectable for tests.
 */
export async function auditPack(
  packageDir: string,
  options: {
    readonly manifest: { readonly name: string; readonly version: string };
    readonly isSourceDistributed: boolean;
    readonly rules?: readonly PackAuditRule[];
    readonly runner?: NpmPackRunner;
  },
): Promise<{ readonly ok: true; readonly result: PackAuditResult } | { readonly ok: false; readonly error: string }> {
  const packResult = await runNpmPack(packageDir, { runner: options.runner });
  if (!packResult.ok) {
    return { ok: false, error: packResult.error };
  }
  // npm pack --json typically emits exactly one entry per invocation.
  // Defensively, audit only the first entry matching the manifest name.
  const entry =
    packResult.entries.find(e => e.name === options.manifest.name) ?? packResult.entries[0];
  if (entry === undefined) {
    return { ok: false, error: 'npm pack returned no entries' };
  }
  const result = auditPackEntry(
    entry,
    {
      packageDir,
      manifest: options.manifest,
      isSourceDistributed: options.isSourceDistributed,
    },
    options.rules ?? DEFAULT_PACK_RULES,
  );
  return { ok: true, result };
}
