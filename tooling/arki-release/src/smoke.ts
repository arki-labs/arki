/**
 * The `smoke` command: install a frozen release candidate in a clean folder
 * OUTSIDE the monorepo and prove it works the way a stranger would use it.
 *
 * Why: `@arki/journal@0.1.0` shipped with `"@arki/log": "0.0.3"` while its code
 * called `getLogger`, which only the unreleased log had. The scorecard ran
 * inside the monorepo, so it never saw the break. Only an outside install does.
 *
 * Every effect (npm, node, bun, vite, tar, dot) goes through the injected
 * {@link ExecRunner}, so tests never touch the network.
 */

import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { appendCandidateCheck, readCandidate, type Candidate } from './candidate';
import { defaultConfigPath, loadConfig } from './config';
import { createEnvelope } from './json-output';
import { execRunner, type ExecRunner, type RunOutput } from './runners';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';

export const SMOKE_ERROR_CODES = {
  installFailed: 'SMOKE_E001',
  importFailed: 'SMOKE_E002',
  viteBuildFailed: 'SMOKE_E003',
  optionalPeerFailed: 'SMOKE_E004',
  dotAppFailed: 'SMOKE_E005',
  duplicateCopy: 'SMOKE_E006',
  resolvesInsideRepo: 'SMOKE_E007',
  candidateInvalid: 'SMOKE_E008',
  waveUnknown: 'SMOKE_E009',
} as const;

const smokeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke');

const manifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    exports: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() }).loose()).optional(),
  })
  .loose();

const lsNodeSchema: z.ZodType<LsNode> = z.lazy(() =>
  z
    .object({
      version: z.string().optional(),
      path: z.string().optional(),
      dependencies: z.record(z.string(), lsNodeSchema).optional(),
    })
    .loose(),
);

type LsNode = {
  version?: string | undefined;
  path?: string | undefined;
  dependencies?: Record<string, LsNode> | undefined;
};

const lsSchema = z.object({ dependencies: z.record(z.string(), lsNodeSchema).optional() }).loose();

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export const SMOKE_CHECK_STATUSES = ['pass', 'fail', 'skip'] as const;
export type SmokeCheckStatus = (typeof SMOKE_CHECK_STATUSES)[number];

export type SmokeCheck = { id: string; status: SmokeCheckStatus; detail: string };

/** `wave` is the synthetic item for checks that cover the whole install. */
export type SmokeKind = 'library' | 'source' | 'wave';

export type SmokeItem = { name: string; kind: SmokeKind; checks: SmokeCheck[] };

export type SmokeSummary = { packages: number; checks: number; failed: number; skipped: number };

export type SmokeOptions = {
  candidateDir: string;
  /** Monorepo root. No installed package may resolve inside it. */
  repoRoot: string;
  config?: ReleaseConfig;
  runner?: ExecRunner;
  /** Parent of the temp consumer folder. Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Keep the consumer folder for debugging. */
  keep?: boolean;
  /** Skip writing `checks.smoke` into candidate.json. */
  record?: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type SmokeLine = { verdict: 'PASS' | 'SKIP' | 'FAIL'; runtime: 'node' | 'bun'; spec: string; rest: string };

const lineRe = /^(PASS|SKIP|FAIL) (node|bun) \S+ ([^\s:]+)(.*)$/;

/** Parse the PASS/SKIP/FAIL lines printed by consumer-smoke.mjs. */
export function parseSmokeOutput(stdout: string): SmokeLine[] {
  const lines: SmokeLine[] = [];
  for (const raw of stdout.split('\n')) {
    const m = lineRe.exec(raw.trim());
    if (m === null) continue;
    const [, verdict, runtime, spec, rest] = m;
    if (verdict === 'PASS' || verdict === 'SKIP' || verdict === 'FAIL') {
      if (runtime === 'node' || runtime === 'bun') lines.push({ verdict, runtime, spec: spec ?? '', rest: (rest ?? '').trim() });
    }
  }
  return lines;
}

function packageOfSpec(spec: string): string {
  return spec.split('/').slice(0, 2).join('/');
}

/** Every `exports` subpath that can be imported by name (no wildcards). */
export function exportSpecs(manifest: z.infer<typeof manifestSchema>): string[] {
  const keys =
    manifest.exports === undefined || typeof manifest.exports === 'string'
      ? ['.']
      : Object.keys(manifest.exports);
  return keys
    .filter(key => key !== './package.json' && !key.includes('*'))
    .map(key => (key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`));
}

type LsCopy = { name: string; version: string; where: string };

function collectArkiCopies(node: LsNode, found: LsCopy[]): void {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (name.startsWith('@arki/')) {
      found.push({ name, version: child.version ?? '?', where: child.path ?? '' });
    }
    collectArkiCopies(child, found);
  }
}

/**
 * Judge an `npm ls --all --json --long` tree: every `@arki/*` must be one
 * physical copy, and none may sit inside the monorepo.
 */
export function judgeTree(
  treeJson: string,
  repoRoot: string,
  realPathOf: (p: string) => string = p => p,
): { duplicates: string[]; insideRepo: string[] } {
  const parsed = lsSchema.safeParse(JSON.parse(treeJson));
  const copies: LsCopy[] = [];
  if (parsed.success) collectArkiCopies(parsed.data, copies);
  const places = new Map<string, Set<string>>();
  const insideRepo = new Set<string>();
  const root = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  for (const copy of copies) {
    const real = copy.where === '' ? '' : realPathOf(copy.where);
    // npm marks repeated references without a path; fall back to the version.
    const key = real === '' ? `version:${copy.version}` : real;
    places.set(copy.name, (places.get(copy.name) ?? new Set()).add(key));
    if (real !== '' && (real + path.sep).startsWith(root)) insideRepo.add(`${copy.name} -> ${real}`);
  }
  const duplicates = [...places].filter(([, set]) => set.size > 1).map(([name, set]) => `${name} (${[...set].join(', ')})`);
  return { duplicates, insideRepo: [...insideRepo] };
}

function check(id: string, status: SmokeCheckStatus, detail: string): SmokeCheck {
  return { id, status, detail };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type InstalledPackage = { name: string; manifest: z.infer<typeof manifestSchema> };

async function readInstalled(consumer: string): Promise<InstalledPackage[]> {
  const root = path.join(consumer, 'node_modules', '@arki');
  let dirs: string[] = [];
  try {
    dirs = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const out: InstalledPackage[] = [];
  for (const dir of dirs) {
    const raw = await readFile(path.join(root, dir, 'package.json'), 'utf8');
    const manifest = manifestSchema.parse(JSON.parse(raw));
    out.push({ name: manifest.name, manifest });
  }
  return out;
}

function brief(result: RunOutput): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' | ');
  return text === '' ? `exit ${result.code}` : `exit ${result.code}: ${text}`;
}

export async function runSmoke(options: SmokeOptions): Promise<ReleaseCommandEnvelope<SmokeItem, SmokeSummary>> {
  const candidateDir = path.resolve(options.candidateDir);
  const run = options.runner ?? execRunner;
  const errors: ReleaseError[] = [];
  const emptySummary: SmokeSummary = { packages: 0, checks: 0, failed: 0, skipped: 0 };
  const bail = (error: ReleaseError): ReleaseCommandEnvelope<SmokeItem, SmokeSummary> =>
    createEnvelope({ command: 'smoke', status: 'failure', summary: emptySummary, errors: [error] });

  // One candidate reader: it validates candidate.json and every tarball's sha512.
  const read = await readCandidate(candidateDir);
  if (!read.ok) {
    return bail({
      code: SMOKE_ERROR_CODES.candidateInvalid,
      severity: 'error',
      message: `Cannot use the candidate in ${candidateDir}: ${read.errors.map(e => `${e.code} ${e.message}`).join(' ')}`,
      remediation: 'Create the candidate first with `bun release:arki candidate --wave <id>`, then pass its folder.',
      target: candidateDir,
    });
  }
  const candidate: Candidate = read.candidate;

  const config = options.config ?? (await loadConfig(defaultConfigPath(options.repoRoot)));
  const wave = config.waves.find(w => w.id === candidate.wave);
  if (wave === undefined) {
    return bail({
      code: SMOKE_ERROR_CODES.waveUnknown,
      severity: 'error',
      message: `Candidate wave "${candidate.wave}" is not in arki.release.config.ts.`,
      remediation: 'Fix the wave id in candidate.json or add the wave to arki.release.config.ts.',
      target: candidate.wave,
    });
  }
  const kind: SmokeKind = wave.buildOutput === 'source' ? 'source' : 'library';

  const consumer = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), 'arki-smoke-'));
  const waveChecks: SmokeCheck[] = [];
  const perPackage = new Map<string, SmokeCheck[]>(candidate.packages.map(p => [p.name, []]));
  const add = (name: string, c: SmokeCheck): void => {
    const list = perPackage.get(name);
    if (list === undefined) waveChecks.push(c);
    else list.push(c);
  };
  const fail = (code: string, message: string, remediation: string, target: string): void => {
    errors.push({ code, severity: 'error', message, remediation, target });
  };

  try {
    // --- Build the consumer package.json: tarballs + exact published deps ---
    const tarballOf = new Map(candidate.packages.map(p => [p.name, path.resolve(candidateDir, p.tarball)]));
    const published = new Map<string, string>();
    for (const pkg of candidate.packages) {
      const shown = await run('tar', ['-xOzf', tarballOf.get(pkg.name) ?? '', 'package/package.json'], { cwd: consumer });
      const manifest = manifestSchema.parse(JSON.parse(shown.stdout));
      for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
        if (dep.startsWith('@arki/') && !tarballOf.has(dep)) published.set(dep, range);
      }
    }
    const fileSpec = (name: string): string => `file:${tarballOf.get(name) ?? ''}`;
    const overrides = Object.fromEntries(candidate.packages.map(p => [p.name, fileSpec(p.name)]));
    const dependencies = { ...Object.fromEntries(published), ...overrides };
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'arki-smoke-consumer', private: true, type: 'module', dependencies, overrides }, null, 2),
    );

    const install = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer });
    if (install.code !== 0) {
      waveChecks.push(check('install', 'fail', brief(install)));
      fail(
        SMOKE_ERROR_CODES.installFailed,
        `npm install of the candidate failed: ${brief(install)}`,
        'Check that every @arki/* dependency version in the tarballs exists on npm or is in the candidate.',
        candidate.wave,
      );
      return await finish();
    }
    waveChecks.push(check('install', 'pass', `${candidate.packages.length} tarball(s) + ${published.size} published dep(s)`));

    // --- Import every subpath on Node and Bun ---
    const installed = await readInstalled(consumer);
    await cp(path.join(smokeDir, 'consumer-smoke.mjs'), path.join(consumer, 'consumer-smoke.mjs'));
    const peerSkips = new Map<string, Set<string>>();
    // Source-distributed packages ship .ts/.css for a bundler; bare runtimes
    // cannot load them, so the Vite build below is their import check.
    const sourcePackages = new Set(config.waves.filter(w => w.buildOutput === 'source').flatMap(w => w.packages));
    for (const runtime of ['node', 'bun'] as const) {
      const result = await run(runtime, ['consumer-smoke.mjs'], { cwd: consumer });
      const lines = parseSmokeOutput(result.stdout);
      for (const pkg of candidate.packages) {
        const mine = lines.filter(l => packageOfSpec(l.spec) === pkg.name);
        const bad = mine.filter(l => l.verdict === 'FAIL');
        const id = `import:${runtime}`;
        if (sourcePackages.has(pkg.name)) {
          add(pkg.name, check(id, 'skip', 'source-distributed: the Vite build checks its imports'));
        } else if (bad.length > 0) {
          add(pkg.name, check(id, 'fail', bad.map(l => `${l.spec}${l.rest}`).join('; ')));
          fail(
            SMOKE_ERROR_CODES.importFailed,
            `${pkg.name} fails to import under ${runtime}: ${bad[0]?.rest ?? ''}`,
            'A dependency pinned by this package is missing something it uses. Add the dependency to the wave or bump its pin, then re-pack.',
            pkg.name,
          );
        } else {
          add(pkg.name, check(id, 'pass', `${mine.filter(l => l.verdict === 'PASS').length} subpath(s) imported`));
        }
        for (const l of mine.filter(l => l.verdict === 'SKIP')) {
          const peer = /optional peer (\S+) not installed/.exec(l.rest)?.[1];
          if (peer !== undefined) peerSkips.set(pkg.name, (peerSkips.get(pkg.name) ?? new Set()).add(peer));
        }
      }
      if (result.code !== 0 && !lines.some(l => l.verdict === 'FAIL')) {
        waveChecks.push(check(`import:${runtime}`, 'fail', brief(result)));
        fail(
          SMOKE_ERROR_CODES.importFailed,
          `consumer-smoke crashed under ${runtime}: ${brief(result)}`,
          `Install ${runtime} or fix the crash, then re-run smoke.`,
          candidate.wave,
        );
      }
    }

    // --- Optional peers: clear error without, works with ---
    if (peerSkips.size > 0) {
      const peerRanges = new Map<string, string>();
      for (const pkg of installed) {
        for (const peer of peerSkips.get(pkg.name) ?? []) {
          peerRanges.set(peer, pkg.manifest.peerDependencies?.[peer] ?? '*');
        }
      }
      const withPeers = path.join(consumer, 'with-peers');
      await mkdir(withPeers);
      await writeFile(
        path.join(withPeers, 'package.json'),
        JSON.stringify({ name: 'arki-smoke-peers', private: true, type: 'module', dependencies: { ...dependencies, ...Object.fromEntries(peerRanges) }, overrides }, null, 2),
      );
      const peerInstall = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: withPeers });
      await cp(path.join(smokeDir, 'consumer-smoke.mjs'), path.join(withPeers, 'consumer-smoke.mjs'));
      const peerRun = peerInstall.code === 0 ? await run('node', ['consumer-smoke.mjs'], { cwd: withPeers }) : peerInstall;
      for (const [name, peers] of peerSkips) {
        const lines = parseSmokeOutput(peerRun.stdout).filter(l => packageOfSpec(l.spec) === name);
        const stillBad = peerInstall.code !== 0 || lines.some(l => l.verdict !== 'PASS');
        const list = [...peers].join(', ');
        add(name, check('optional-peer', stillBad ? 'fail' : 'pass', stillBad ? `with ${list} installed: ${brief(peerRun)}` : `clear error without ${list}; imports with it`));
        if (stillBad) {
          fail(
            SMOKE_ERROR_CODES.optionalPeerFailed,
            `${name} does not import even with optional peer(s) ${list} installed.`,
            'Check the peerDependencies range of the optional peer and the entry that needs it.',
            name,
          );
        }
      }
    }

    // --- Source-distributed packages: a Vite build must pass ---
    if (kind === 'source') {
      const viteDir = path.join(consumer, 'vite-fixture');
      await cp(path.join(smokeDir, 'vite-fixture'), viteDir, { recursive: true });
      const imports = installed
        .filter(p => tarballOf.has(p.name))
        .flatMap(p => exportSpecs(p.manifest))
        .map((spec, i) => `import * as m${i} from '${spec}';\nvoid m${i};`);
      await writeFile(path.join(viteDir, 'src', 'main.ts'), `${imports.join('\n')}\nexport {};\n`);
      const viteInstall = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: viteDir });
      const build = viteInstall.code === 0 ? await run('npx', ['--no-install', 'vite', 'build'], { cwd: viteDir }) : viteInstall;
      const ok = build.code === 0;
      waveChecks.push(check('vite-build', ok ? 'pass' : 'fail', ok ? `${imports.length} subpath(s) bundled` : brief(build)));
      if (!ok) {
        fail(
          SMOKE_ERROR_CODES.viteBuildFailed,
          `Vite could not build a page that imports every subpath: ${brief(build)}`,
          'Source-distributed packages must bundle in a plain Vite project. Fix the failing import or its dependency.',
          candidate.wave,
        );
      }
    }

    // --- One copy of each @arki/*, none inside the monorepo ---
    const tree = await run('npm', ['ls', '--all', '--json', '--long'], { cwd: consumer });
    const realOf = new Map<string, string>();
    for (const m of tree.stdout.matchAll(/"path":\s*"([^"]+)"/g)) {
      const p = m[1] ?? '';
      realOf.set(p, await realpath(p).catch(() => p));
    }
    const judged = judgeTree(tree.stdout === '' ? '{}' : tree.stdout, await realpath(options.repoRoot).catch(() => options.repoRoot), p => realOf.get(p) ?? p);
    waveChecks.push(check('one-copy', judged.duplicates.length === 0 ? 'pass' : 'fail', judged.duplicates.join('; ') || 'each @arki/* resolves once'));
    if (judged.duplicates.length > 0) {
      fail(
        SMOKE_ERROR_CODES.duplicateCopy,
        `More than one copy installed: ${judged.duplicates.join('; ')}`,
        'Align the pinned versions of the duplicated package across the wave, or add it to the wave.',
        candidate.wave,
      );
    }
    waveChecks.push(check('outside-repo', judged.insideRepo.length === 0 ? 'pass' : 'fail', judged.insideRepo.join('; ') || 'no path resolves inside the monorepo'));
    if (judged.insideRepo.length > 0) {
      fail(
        SMOKE_ERROR_CODES.resolvesInsideRepo,
        `Installed packages resolve inside the monorepo: ${judged.insideRepo.join('; ')}`,
        'The smoke folder must be outside the repo and use tarballs, not workspace links.',
        candidate.wave,
      );
    }

    // --- Dot: scaffold an app from the packed CLI and run its pipeline ---
    if (tarballOf.has('@arki/dot')) {
      const appDir = path.join(consumer, 'smoke-app');
      const steps: Array<[string, string, string[], string]> = [
        ['new', 'npx', ['--no-install', 'dot', 'new', 'smoke-app', '--target', appDir], consumer],
        ['install', 'bun', ['install'], appDir],
        ['typecheck', 'bun', ['run', 'typecheck'], appDir],
        ['test', 'bun', ['run', 'test'], appDir],
        ['build', 'bun', ['run', 'build'], appDir],
      ];
      let broken = false;
      for (const [id, command, args, cwd] of steps) {
        if (broken) {
          add('@arki/dot', check(`dot:${id}`, 'skip', 'an earlier step failed'));
          continue;
        }
        const result = await run(command, args, { cwd });
        add('@arki/dot', check(`dot:${id}`, result.code === 0 ? 'pass' : 'fail', result.code === 0 ? 'ok' : brief(result)));
        if (result.code !== 0) {
          broken = true;
          fail(
            SMOKE_ERROR_CODES.dotAppFailed,
            `\`dot new\` app step "${id}" failed: ${brief(result)}`,
            'Run the step by hand in the temp app (use --keep) and fix the template or the packed CLI.',
            '@arki/dot',
          );
        }
        if (id === 'new' && result.code === 0) {
          // Bun honors only flat `overrides`; point the app at the same tarballs.
          const pkgPath = path.join(appDir, 'package.json');
          const appPkg = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(pkgPath, 'utf8')));
          await writeFile(pkgPath, JSON.stringify({ ...appPkg, overrides }, null, 2));
        }
      }
    }
    return await finish();
  } finally {
    if (options.keep !== true) await rm(consumer, { recursive: true, force: true });
  }

  async function finish(): Promise<ReleaseCommandEnvelope<SmokeItem, SmokeSummary>> {
    const items: SmokeItem[] = [
      { name: '(wave)', kind: 'wave', checks: waveChecks },
      ...[...perPackage].map(([name, checks]): SmokeItem => ({ name, kind, checks })),
    ];
    const all = items.flatMap(i => i.checks);
    const failed = all.filter(c => c.status === 'fail').length;
    const envelope = createEnvelope<SmokeItem, SmokeSummary>({
      command: 'smoke',
      status: failed === 0 ? 'success' : 'failure',
      summary: { packages: candidate.packages.length, checks: all.length, failed, skipped: all.filter(c => c.status === 'skip').length },
      items,
      errors,
    });
    if (options.record === false) return envelope;
    const recorded = await appendCandidateCheck(candidateDir, 'smoke', { status: envelope.status, envelope });
    return recorded.ok ? envelope : { ...envelope, status: 'failure', errors: [...envelope.errors, ...recorded.errors] };
  }
}
