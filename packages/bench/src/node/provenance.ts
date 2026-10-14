/**
 * Provenance: everything a reader needs to judge or reproduce a result —
 * exact package versions, machine, runtime flags, source revision and how
 * busy the machine was. Call it in the process that measured, right after
 * the run: flags and load describe the current process.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, availableParallelism, cpus, loadavg, release, type } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { BenchResult, Environment, GroupResult, Warning } from '../core/types.js';

const run = promisify(execFile);

const HARNESS = '@arki/bench';

function readVersion(packageJson: string, expectedName?: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (expectedName !== undefined && (!('name' in parsed) || parsed.name !== expectedName)) return undefined;
    return 'version' in parsed && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed version of `name` as seen from `cwd`: the package itself
 * (a suite benchmarking its own package), then Node resolution of
 * `<name>/package.json`, then a walk up through `node_modules` folders
 * (for packages whose `exports` map hides `package.json`).
 */
export function resolveInstalledVersion(name: string, cwd: string): string | undefined {
  const own = readVersion(path.join(cwd, 'package.json'), name);
  if (own !== undefined) return own;

  try {
    const resolved = createRequire(path.join(cwd, 'noop.js')).resolve(`${name}/package.json`);
    const version = readVersion(resolved, name);
    if (version !== undefined) return version;
  } catch {
    // Not resolvable this way; walk node_modules below.
  }

  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) {
      const version = readVersion(candidate, name);
      if (version !== undefined) return version;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The root of this package (`@arki/bench`), from dist or src. */
function harnessRoot(): string | undefined {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (readVersion(path.join(dir, 'package.json'), HARNESS) !== undefined) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Real versions of the harness and of the mitata copy it loads. */
export function harnessVersions(): { version: string; mitata: string } {
  const root = harnessRoot();
  const version = root === undefined ? undefined : readVersion(path.join(root, 'package.json'), HARNESS);
  const mitata = root === undefined ? undefined : resolveInstalledVersion('mitata', root);
  return { version: version ?? 'unknown', mitata: mitata ?? 'unknown' };
}

async function gitState(cwd: string): Promise<Environment['git'] | undefined> {
  try {
    const [head, status] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { cwd }),
      run('git', ['status', '--porcelain', '--', '.'], { cwd }),
    ]);
    const revision = head.stdout.trim();
    if (revision === '') return undefined;
    return { revision, dirty: status.stdout.trim() !== '' };
  } catch {
    return undefined;
  }
}

/** 1-minute load average; undefined where the OS has none (Windows reports zeros). */
export function currentLoad(): number | undefined {
  if (process.platform === 'win32') return undefined;
  const [oneMinute] = loadavg();
  return oneMinute;
}

function cores(): number {
  try {
    return availableParallelism();
  } catch {
    return cpus().length;
  }
}

/**
 * Adds a blocking `busy-machine` warning when the 1-minute load was above
 * half the cores at the start or end of the run, in every profile (only a
 * publish run could be publishable, so it matters there), unless every group
 * is a size or deterministic metric group, which load cannot change. This is the host's
 * early warning; data-driven checks (spread of the blocks) belong to the engine.
 */
export function applyLoadCheck(result: BenchResult): BenchResult {
  const { load, cores: count } = result.environment;
  if (load === undefined || count === undefined || count <= 0) return result;
  // Load cannot change a byte count or a deterministic metric: only timed or repeated groups are affected.
  if (!result.groups.some(group => loadSensitive(group))) return result;
  const limit = count / 2;
  if (load[0] <= limit && load[1] <= limit) return result;
  const warnings: readonly Warning[] = result.warnings.some(warning => warning.code === 'busy-machine')
    ? result.warnings
    : [
        ...result.warnings,
        {
          code: 'busy-machine',
          message:
            `The machine was busy: 1-minute load ${load[0].toFixed(1)} at the start and ${load[1].toFixed(1)} at the end, ` +
            `above half of its ${String(count)} cores. Other programs competed for the CPU, so timings are noisier. ` +
            'Close them and run again.',
        },
      ];
  return { ...result, warnings, publishable: false };
}

function loadSensitive(group: GroupResult): boolean {
  if (group.kind === 'size') return false;
  return group.kind !== 'metric' || group.deterministic !== true;
}

function dedupe(warnings: readonly Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter(warning => {
    const key = JSON.stringify([warning.code, warning.group, warning.case, warning.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fills `packages` (every case's package, plus `@arki/bench` and `mitata`)
 * and the host part of `environment`: OS, CPU, cores, runtime flags, git
 * revision and load. Keeps a `load` the caller already recorded around the
 * run; otherwise samples it now. Safe to call twice.
 */
export async function collectProvenance(result: BenchResult, options: { cwd: string }): Promise<BenchResult> {
  const cwd = path.resolve(options.cwd);
  const harness = harnessVersions();
  const warnings: Warning[] = [...result.warnings];
  const packages: Record<string, string> = { ...result.packages, [HARNESS]: harness.version, mitata: harness.mitata };

  const names = new Set<string>();
  for (const group of result.groups) {
    for (const item of group.cases) if (item.package !== undefined) names.add(item.package);
  }
  for (const name of [...names].toSorted()) {
    const version = resolveInstalledVersion(name, cwd);
    packages[name] = version ?? 'unknown';
    if (version === undefined) {
      warnings.push({
        code: 'package-version-unknown',
        message: `Could not find the installed version of ${name} from ${cwd}; it is recorded as "unknown". Install it in this package.`,
      });
    }
  }

  const git = await gitState(cwd);
  const now = currentLoad();
  const load = result.environment.load ?? (now === undefined ? undefined : ([now, now] as const));
  const model = cpus()[0]?.model;

  const environment: Environment = {
    ...result.environment,
    os: `${type()} ${release()}`,
    arch: arch(),
    ...(model === undefined ? {} : { cpu: model.trim() }),
    cores: cores(),
    flags: [...process.execArgv],
    harness,
    ...(git === undefined ? {} : { git }),
    ...(load === undefined ? {} : { load }),
  };

  return applyLoadCheck({ ...result, packages, environment, warnings: dedupe(warnings) });
}
