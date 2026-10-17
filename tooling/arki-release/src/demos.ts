/**
 * Demo registry, proof map and demo lag.
 *
 * A demo is a nested repo (for example `demos/drop-studio`) that pins
 * `@arki/*` versions in its `arki.deps.json`. This module answers three
 * questions for the release scorecard:
 *
 *   1. Which demos use a package? (`demosUsing`: real `@arki/<x>` imports
 *      in the demo source, plus the hand-written `proofs` map.)
 *   2. How far behind the candidate is each demo's pin? (`evaluateDemoLag`)
 *   3. What config shape does all of this need? (`DemoConfig`, which
 *      the later wiring step adds to `ReleaseConfig`.)
 *
 * Nested demo repos are absent in CI clones, so a missing demo folder is a
 * warning and never a crash.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { DemoEntry, ProofEntry, ReleaseConfig, ReleaseError, ScorecardDimensionResult, ScorecardStatus } from './types';

/** Stable error codes emitted by the demo registry. */
export const DEMO_ERROR_CODES = {
  /** Config `demos` / `proofs` / `demoLagBlocking` has the wrong shape. */
  invalidConfig: 'DEMO_E001',
  /** A demo folder or its `arki.deps.json` is missing or unreadable. */
  demoMissing: 'DEMO_E002',
  /** A demo pins a name that is not a package in this workspace. */
  pinNotAPackage: 'DEMO_E003',
  /** A demo imports a package it does not pin. */
  importNotPinned: 'DEMO_E004',
  /** A demo pin is behind the candidate by more than one minor (or a major). */
  lagWarn: 'DEMO_E005',
  /** A demo pin is behind the candidate by more than two minors (or a major). */
  lagFail: 'DEMO_E006',
} as const;

/** The demo fields of `ReleaseConfig` that this module validates and reads. */
export type DemoConfig = Pick<ReleaseConfig, 'demos' | 'proofs' | 'demoLagBlocking'>;

const demoEntrySchema = z.object({
  name: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must look like owner/repo'),
  path: z.string().min(1),
});

const proofEntrySchema = z.object({
  demo: z.string().min(1),
  scenario: z.string().min(1),
});

const demoConfigSchema = z.object({
  demos: z.array(demoEntrySchema).optional(),
  proofs: z.record(z.string().startsWith('@arki/'), z.array(proofEntrySchema)).optional(),
  demoLagBlocking: z.boolean().optional(),
});

/**
 * Validate the demo fields of a raw config object. Other keys are ignored.
 * Also checks that no demo name repeats and every proof names a known demo.
 */
export function validateDemoConfig(raw: unknown): DemoConfig | ReleaseError[] {
  const parsed = demoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map(issue => ({
      code: DEMO_ERROR_CODES.invalidConfig,
      severity: 'error',
      message: `Config \`${issue.path.join('.') || '(root)'}\`: ${issue.message}`,
      remediation: 'Fix `demos`, `proofs` or `demoLagBlocking` in arki.release.config.ts.',
      target: 'arki.release.config.ts',
    }));
  }
  const { demos, proofs, demoLagBlocking } = parsed.data;
  const errors: ReleaseError[] = [];
  const names = new Set<string>();
  for (const demo of demos ?? []) {
    if (names.has(demo.name)) {
      errors.push(configError(`Demo \`${demo.name}\` is listed twice.`, 'Give each demo a unique name.'));
    }
    names.add(demo.name);
  }
  for (const [pkg, entries] of Object.entries(proofs ?? {})) {
    for (const entry of entries) {
      if (!names.has(entry.demo)) {
        errors.push(
          configError(
            `Proof for \`${pkg}\` names demo \`${entry.demo}\`, which is not in \`demos\`.`,
            'Add the demo to `demos` or fix the demo name.',
          ),
        );
      }
    }
  }
  if (errors.length > 0) return errors;
  return {
    ...(demos === undefined ? {} : { demos }),
    ...(proofs === undefined ? {} : { proofs }),
    ...(demoLagBlocking === undefined ? {} : { demoLagBlocking }),
  };
}

function configError(message: string, remediation: string): ReleaseError {
  return {
    code: DEMO_ERROR_CODES.invalidConfig,
    severity: 'error',
    message,
    remediation,
    target: 'arki.release.config.ts',
  };
}

const depsFileSchema = z.object({
  linkRoot: z.string(),
  packages: z.record(z.string(), z.object({ path: z.string(), version: z.string() })),
});

const packageJsonVersionSchema = z.object({ version: z.string() });

export type DemoPin = {
  readonly pinned: string;
  /** Version of the package in this workspace; absent when it is not a package. */
  readonly sourceVersion?: string;
};

export type LoadedDemo = {
  readonly entry: DemoEntry;
  readonly present: boolean;
  /** Package name -> pin. */
  readonly pins: ReadonlyMap<string, DemoPin>;
  /** Package names imported in the demo source (subpaths folded in). */
  readonly imports: ReadonlySet<string>;
};

export type DemoRegistry = {
  readonly demos: readonly LoadedDemo[];
  readonly proofs: Readonly<Record<string, readonly ProofEntry[]>>;
  /** Warnings and errors found while loading. */
  readonly errors: readonly ReleaseError[];
};

export type DemoUse = {
  readonly demo: string;
  readonly via: readonly ('import' | 'proof')[];
  readonly scenarios: readonly string[];
  /** Pinned version; absent when the demo is missing or does not pin it. */
  readonly pinned?: string;
};

const SOURCE_DIRS_SKIP = new Set(['node_modules', 'dist', '.git']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const ARKI_IMPORT = /(?:from|import|require)\s*\(?\s*['"](@arki\/[\w-]+)/g;

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (SOURCE_DIRS_SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `@arki/<x>` imported under `<demo>/src` and `<demo>/<layer>/src`. */
async function scanImports(demoDir: string): Promise<Set<string>> {
  const roots = [path.join(demoDir, 'src')];
  try {
    for (const entry of await readdir(demoDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SOURCE_DIRS_SKIP.has(entry.name)) {
        roots.push(path.join(demoDir, entry.name, 'src'));
      }
    }
  } catch {
    return new Set();
  }
  const found = new Set<string>();
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(ARKI_IMPORT)) {
        const name = match[1];
        if (name !== undefined) found.add(name);
      }
    }
  }
  return found;
}

function warn(code: string, message: string, remediation: string, target: string): ReleaseError {
  return { code, severity: 'warning', message, remediation, target };
}

async function loadDemo(cwd: string, entry: DemoEntry, errors: ReleaseError[]): Promise<LoadedDemo> {
  const demoDir = path.join(cwd, entry.path);
  const depsFile = path.join(demoDir, 'arki.deps.json');
  const absent: LoadedDemo = { entry, present: false, pins: new Map(), imports: new Set() };

  if (!(await exists(depsFile))) {
    errors.push(
      warn(
        DEMO_ERROR_CODES.demoMissing,
        `Demo \`${entry.name}\` has no arki.deps.json at ${entry.path}. Nested demo repos are absent in CI clones.`,
        `Clone ${entry.repo} to ${entry.path} to get demo-lag results for it.`,
        entry.name,
      ),
    );
    return absent;
  }
  const parsed = depsFileSchema.safeParse(JSON.parse(await readFile(depsFile, 'utf8')));
  if (!parsed.success) {
    errors.push(
      warn(
        DEMO_ERROR_CODES.demoMissing,
        `Demo \`${entry.name}\` has an unreadable arki.deps.json: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
        'Expected { linkRoot, packages: { "@arki/x": { path, version } } }.',
        entry.name,
      ),
    );
    return absent;
  }

  const pins = new Map<string, DemoPin>();
  for (const [name, pin] of Object.entries(parsed.data.packages)) {
    const pkgJson = path.resolve(demoDir, parsed.data.linkRoot, pin.path, 'package.json');
    let sourceVersion: string | undefined;
    try {
      sourceVersion = packageJsonVersionSchema.parse(JSON.parse(await readFile(pkgJson, 'utf8'))).version;
    } catch {
      errors.push(
        warn(
          DEMO_ERROR_CODES.pinNotAPackage,
          `Demo \`${entry.name}\` pins \`${name}\`, but no package exists at ${path.join(parsed.data.linkRoot, pin.path)}.`,
          `Remove \`${name}\` from ${entry.path}/arki.deps.json, or point it at a real package.`,
          name,
        ),
      );
    }
    pins.set(name, { pinned: pin.version, ...(sourceVersion === undefined ? {} : { sourceVersion }) });
  }

  const imports = await scanImports(demoDir);
  for (const name of imports) {
    if (!pins.has(name)) {
      errors.push(
        warn(
          DEMO_ERROR_CODES.importNotPinned,
          `Demo \`${entry.name}\` imports \`${name}\` but does not pin it in arki.deps.json.`,
          `Add \`${name}\` to ${entry.path}/arki.deps.json.`,
          name,
        ),
      );
    }
  }
  return { entry, present: true, pins, imports };
}

/** Read every configured demo. Never throws for a missing demo. */
export async function loadDemos(cwd: string, config: DemoConfig): Promise<DemoRegistry> {
  const errors: ReleaseError[] = [];
  const demos: LoadedDemo[] = [];
  for (const entry of config.demos ?? []) demos.push(await loadDemo(cwd, entry, errors));
  return { demos, proofs: config.proofs ?? {}, errors };
}

/** Demos that use `pkg`: real imports in demo source, plus configured proofs. */
export function demosUsing(registry: DemoRegistry, pkg: string): DemoUse[] {
  const uses: DemoUse[] = [];
  for (const demo of registry.demos) {
    const via: ('import' | 'proof')[] = [];
    if (demo.imports.has(pkg)) via.push('import');
    const proofs = (registry.proofs[pkg] ?? []).filter(p => p.demo === demo.entry.name);
    if (proofs.length > 0) via.push('proof');
    if (via.length === 0) continue;
    const pinned = demo.pins.get(pkg)?.pinned;
    uses.push({
      demo: demo.entry.name,
      via,
      scenarios: proofs.map(p => p.scenario),
      ...(pinned === undefined ? {} : { pinned }),
    });
  }
  return uses;
}

type Semver = { readonly major: number; readonly minor: number };

function parseSemver(version: string): Semver | undefined {
  const match = /^[\^~]?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** How far a pin trails the candidate. A pin that is ahead counts as 0. */
export type Lag = { readonly majorsBehind: number; readonly minorsBehind: number };

export function computeLag(pinned: string, candidate: string): Lag | undefined {
  const pin = parseSemver(pinned);
  const target = parseSemver(candidate);
  if (pin === undefined || target === undefined) return undefined;
  if (pin.major > target.major) return { majorsBehind: 0, minorsBehind: 0 };
  if (pin.major < target.major) return { majorsBehind: target.major - pin.major, minorsBehind: 0 };
  return { majorsBehind: 0, minorsBehind: Math.max(0, target.minor - pin.minor) };
}

export type DemoLagInput = {
  readonly pkg: string;
  readonly candidateVersion: string;
  readonly uses: readonly DemoUse[];
  /** From config `demoLagBlocking`; failures become warnings unless true. */
  readonly blocking: boolean;
  /** From `ship --allow-demo-lag "<reason>"`; turns a fail into a warn. */
  readonly allowReason?: string;
};

/**
 * Worst lag across the demos that use the package. Warn above 1 minor
 * behind (or any major behind is a fail); fail above 2 minors.
 */
export function evaluateDemoLag(input: DemoLagInput): ScorecardDimensionResult {
  const { pkg, candidateVersion, uses, blocking, allowReason } = input;
  if (uses.length === 0) {
    return { status: 'pass', details: 'No demo uses this package.', evidence: [] };
  }
  const rows = uses.map(use => ({
    demo: use.demo,
    pinned: use.pinned,
    lag: use.pinned === undefined ? undefined : computeLag(use.pinned, candidateVersion),
  }));
  const known = rows.flatMap(r => (r.lag === undefined || r.pinned === undefined ? [] : [{ ...r, lag: r.lag, pinned: r.pinned }]));
  if (known.length === 0) {
    return {
      status: 'warn',
      details: `Demo lag unknown: ${uses.map(u => u.demo).join(', ')} use ${pkg} but have no readable pin.`,
      evidence: [
        warn(
          DEMO_ERROR_CODES.demoMissing,
          `No pin found for ${pkg} in ${uses.map(u => u.demo).join(', ')}.`,
          'Clone the demo and pin the package in its arki.deps.json.',
          pkg,
        ),
      ],
    };
  }

  const severity = (lag: Lag): number => (lag.majorsBehind > 0 || lag.minorsBehind > 2 ? 2 : lag.minorsBehind > 1 ? 1 : 0);
  const worst = known.reduce((a, b) => (severity(b.lag) > severity(a.lag) || (severity(b.lag) === severity(a.lag) && b.lag.minorsBehind > a.lag.minorsBehind) ? b : a));
  const level = severity(worst.lag);
  const behind = worst.lag.majorsBehind > 0 ? `${worst.lag.majorsBehind} major(s)` : `${worst.lag.minorsBehind} minor(s)`;
  const summary = `${worst.demo} pins ${pkg} ${worst.pinned}, ${behind} behind ${candidateVersion}`;

  if (level === 0) {
    return { status: 'pass', details: `${summary}; within tolerance.`, evidence: [] };
  }
  const remediation = `Bump ${pkg} in ${worst.demo}/arki.deps.json to ${candidateVersion} and run its checks.`;
  if (level === 1) {
    return {
      status: 'warn',
      details: summary,
      evidence: [warn(DEMO_ERROR_CODES.lagWarn, summary, remediation, pkg)],
    };
  }
  const allowed = allowReason !== undefined && allowReason.length > 0;
  const status: ScorecardStatus = blocking && !allowed ? 'fail' : 'warn';
  const note = allowed ? ` (allowed: ${allowReason})` : blocking ? '' : ' (demo lag is warning-only for now)';
  return {
    status,
    details: `${summary}${note}`,
    evidence: [
      {
        code: DEMO_ERROR_CODES.lagFail,
        severity: status === 'fail' ? 'error' : 'warning',
        message: `${summary}${note}`,
        remediation: `${remediation} Or pass --allow-demo-lag "<reason>" to ship.`,
        target: pkg,
      },
    ],
  };
}
