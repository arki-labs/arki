import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCandidate, type Candidate } from './candidate';
import { createEnvelope } from './json-output';
import type { RunOutput } from './runners';
import { integrityOf, runShip, SHIP_ERROR_CODES, type ShipDeps, type ShipMode } from './ship';
import type { ReleaseConfig } from './types';

const config: ReleaseConfig = {
  publicTreePath: '.release/public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.com/r.git' },
    bugs: { url: 'https://example.com/i' },
    homepage: 'https://example.com',
    keywords: [],
    publishConfig: { access: 'public' },
  },
  waves: [
    { id: 'foundation', label: 'Foundation', packages: ['@arki/a', '@arki/b'] },
    { id: 'specialized', label: 'Specialized', packages: ['@arki/x'] },
  ],
};

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
const ok = (stdout = ''): RunOutput => ({ code: 0, stdout, stderr: '' });

/** Every process call `ship` makes, whatever runner it went through. */
type Call = { readonly via: 'exec' | 'npm' | 'git'; readonly command: string };

let root: string;
let calls: Call[];
/** `name@version` -> what `npm view ... dist.integrity --json` prints; absent = not published. */
let published: Map<string, string>;
/** Package names `npm view <name> versions` knows; others answer E404 (never published). */
let released: Set<string>;

function writePackage(name: string, version: string, scripts: Record<string, string> = {}): void {
  mkdirSync(path.join(root, 'packages', name), { recursive: true });
  writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@arki/${name}`, version, scripts }));
  writeFileSync(path.join(root, 'packages', name, 'CHANGELOG.md'), `# @arki/${name}\n`);
}

function addDependencies(name: string, fields: Record<string, unknown>): void {
  const manifestFile = path.join(root, 'packages', name, 'package.json');
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(readFileSync(manifestFile, 'utf8')), ...fields }));
}

function writeChangeset(file: string, bumps: Record<string, string>): void {
  const front = Object.entries(bumps).map(([pkg, bump]) => `'${pkg}': ${bump}`).join('\n');
  writeFileSync(path.join(root, '.changeset', file), `---\n${front}\n---\n\nA change.\n`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-ship-'));
  calls = [];
  published = new Map();
  released = new Set(['@arki/a']);
  writePackage('a', '0.1.0', { 'test:docs': 'arki-doc-examples' });
  writePackage('b', '0.1.0');
  writePackage('x', '0.1.0');
  mkdirSync(path.join(root, '.changeset'));
  writeChangeset('a-feature.md', { '@arki/a': 'minor' });
  writeChangeset('x-feature.md', { '@arki/x': 'patch' });
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', '.bin', 'changeset'), '');
  mkdirSync(path.join(root, 'apps', 'arki', 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'apps', 'arki', 'docs', 'RELEASES.md'), '# ARKI Release Ledger\n\nIntro.\n\n---\n\n## v0.0.1 — older\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Freezes a candidate the way `runCandidate` would: real files, real sha512. */
function freeze(): string {
  const dir = path.join(root, '.release', 'candidates', `foundation-${COMMIT.slice(0, 7)}`);
  mkdirSync(path.join(dir, 'tarballs'), { recursive: true });
  const bytes = Buffer.from('frozen tarball bytes of @arki/a');
  writeFileSync(path.join(dir, 'tarballs', 'arki-a-0.2.0.tgz'), bytes);
  const candidate: Candidate = {
    wave: 'foundation',
    sourceCommit: COMMIT,
    createdAt: '2026-10-17T00:00:00.000Z',
    packages: [
      { name: '@arki/a', version: '0.2.0', tarball: 'tarballs/arki-a-0.2.0.tgz', sha512: createHash('sha512').update(bytes).digest('hex'), publishOrder: 1 },
    ],
    checks: {},
  };
  writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(candidate));
  return dir;
}

function deps(overrides: Partial<ShipDeps> = {}): Partial<ShipDeps> {
  return {
    exec: async (command, args, opts) => {
      calls.push({ via: 'exec', command: [command, ...args].join(' ') });
      if (args[1] === 'version') {
        // What `changeset version` does: bump @arki/a's version (keeping its other fields), consume its changeset.
        const manifestFile = path.join(root, 'packages', 'a', 'package.json');
        writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(readFileSync(manifestFile, 'utf8')), version: '0.2.0' }));
        rmSync(path.join(root, '.changeset', 'a-feature.md'));
      }
      if (args.includes('arki:candidate')) {
        // What a demo prints when the candidate breaks its typecheck.
        const steps = [
          { id: 'prepare', ok: true, detail: 'ok' },
          { id: 'install', ok: true, detail: 'ok' },
          { id: 'typecheck', ok: false, detail: 'TS2305' },
        ];
        return { code: 1, stdout: JSON.stringify({ steps }), stderr: '' };
      }
      if (args.includes('test:docs')) {
        expect(opts.cwd).toBe(path.join(root, 'packages', 'a'));
        return ok(JSON.stringify({ examples: 3, modules: 1, compiled: 1, ran: 1, skipped: 1, skippedBlocks: [{ file: 'README.md', line: 9, reason: 'needs Stripe keys' }], failures: [] }));
      }
      return ok();
    },
    npm: async args => {
      calls.push({ via: 'npm', command: ['npm', ...args].join(' ') });
      if (args[0] === 'view' && args[2] === 'versions') {
        return released.has(args[1] ?? '') ? ok(JSON.stringify(['0.1.0'])) : { code: 1, stdout: '', stderr: 'npm error code E404' };
      }
      const integrity = published.get(args[1] ?? '');
      return integrity === undefined ? { code: 1, stdout: '', stderr: 'npm error code E404' } : ok(JSON.stringify(integrity));
    },
    git: async args => {
      calls.push({ via: 'git', command: ['git', ...args].join(' ') });
      return ok(COMMIT);
    },
    order: async () =>
      createEnvelope({
        command: 'order',
        status: 'success',
        summary: { message: 'ok', wave: 'foundation', candidates: 1, publishedDeps: 0 },
        items: [{ name: '@arki/a', version: '0.1.0', kind: 'candidate', publishOrder: 1 }],
      }),
    candidate: async () => {
      const directory = freeze();
      return createEnvelope({
        command: 'candidate',
        status: 'success',
        summary: { message: 'frozen', wave: 'foundation', sourceCommit: COMMIT, directory, packages: 1 },
      });
    },
    smoke: async () =>
      createEnvelope({ command: 'smoke', status: 'success', summary: { packages: 1, checks: 4, failed: 0, skipped: 0 } }),
    scorecard: async () =>
      createEnvelope({
        command: 'scorecard',
        status: 'success',
        summary: {
          message: 'open',
          totalPackages: 1,
          pass: 1,
          fail: 0,
          warn: 0,
          deferred: 0,
          stableReleaseGate: 'open',
          stableReleaseBlockers: [],
          allowDeferred: false,
        },
      }),
    env: {},
    isTTY: true,
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    ...overrides,
  };
}

const ship = (mode: ShipMode, overrides: Partial<ShipDeps> = {}) => runShip({ cwd: root, config, mode, deps: deps(overrides) });

/** A remote write or a commit, in any spelling a runner could receive it. */
function forbidden(call: Call): boolean {
  return /\bpublish\b/.test(call.command) || /\bpush\b/.test(call.command) || /\bcommit\b/.test(call.command) || /\bgh\b/.test(call.command);
}

describe('ship', () => {
  it('never publishes, pushes or commits, from start through resume and finish', async () => {
    // Why: A-26/A-27 make npm publish, git push and git commit founder or
    // orchestrator acts. If ship ever ran one, an agent could release
    // unreviewed bytes or commit over a twin session's work.
    const started = await ship({ kind: 'start', wave: 'foundation', dryRun: false });
    expect(started.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.commitNeeded]);
    const resumed = await ship({ kind: 'resume', wave: 'foundation', dryRun: false });
    expect(resumed.status).toBe('success');
    const dir = resumed.summary.candidateDir ?? '';
    published.set('@arki/a@0.2.0', integrityOf((await candidateOf(dir)).packages[0]?.sha512 ?? ''));
    const finished = await ship({ kind: 'finish', candidateDir: dir });
    expect(finished.status).toBe('warning'); // sync is not wired: deferred, not faked
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(forbidden)).toEqual([]);
  });

  it('stops after version and build with the exact pathspec commit line', async () => {
    // Why: the orchestrator commits by pathspec in a shared tree; a wrong
    // path list would commit another agent's files or miss a bump.
    const envelope = await ship({ kind: 'start', wave: 'foundation', dryRun: false });
    const stop = envelope.errors[0];
    expect(stop?.code).toBe(SHIP_ERROR_CODES.commitNeeded);
    expect(envelope.summary.next).toBe(
      'git -c commit.gpgsign=false commit -- packages/a/package.json packages/a/CHANGELOG.md .changeset/a-feature.md',
    );
    // Other waves' changesets are left pending, never versioned by this ship.
    const version = calls.find(c => c.command.includes(' version'));
    expect(version?.command).toContain('--ignore @arki/x');
    expect(existsSync(path.join(root, '.changeset', 'x-feature.md'))).toBe(true);
  });

  it('refuses a changeset that also bumps a package outside the wave, before changing anything', async () => {
    // Why: `changeset version` would bump @arki/x, which this ship never
    // publishes, leaving source versions npm has never seen.
    writeChangeset('mixed.md', { '@arki/a': 'patch', '@arki/x': 'patch' });
    const envelope = await ship({ kind: 'start', wave: 'foundation', dryRun: false });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.foreignChangeset]);
    expect(envelope.errors[0]?.target).toBe('@arki/x');
    expect(calls.filter(c => c.via === 'exec')).toEqual([]);
  });

  it('never ignores a package the set depends on, even through an optional peer', async () => {
    // Why: `changeset version` exits 1 when a versioned package depends on an
    // ignored one, so ignoring a dependency blocks every wave that has one.
    addDependencies('a', { peerDependencies: { '@arki/x': 'workspace:*' }, peerDependenciesMeta: { '@arki/x': { optional: true } } });
    rmSync(path.join(root, '.changeset', 'x-feature.md'));
    const envelope = await ship({ kind: 'start', wave: 'foundation', dryRun: false });
    expect(envelope.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.commitNeeded]);
    const version = calls.find(c => c.command.includes(' version'));
    expect(version?.command).not.toContain('--ignore @arki/x');
    expect(version?.command).toContain('--ignore @arki/b');
  });

  it('refuses when the set depends on a package with pending changesets in another wave', async () => {
    // Why: changeset version would bump that dependency, which this ship never
    // publishes. The other wave must ship first.
    addDependencies('a', { dependencies: { '@arki/x': 'workspace:*' } });
    const envelope = await ship({ kind: 'start', wave: 'foundation', dryRun: false });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => [e.code, e.target])).toEqual([[SHIP_ERROR_CODES.foreignChangeset, '@arki/x']]);
    expect(envelope.errors[0]?.remediation).toContain('Ship the specialized wave first');
    expect(calls.filter(c => c.via === 'exec')).toEqual([]);
  });

  it('versions a dependency that is in no wave with the set, since npm has never seen it', async () => {
    // Why: a held public package (config `notYet`) cannot be ignored while a
    // wave package depends on it, and no other ship would ever consume its changesets.
    writePackage('held', '0.0.2');
    addDependencies('a', { peerDependencies: { '@arki/held': 'workspace:*' } });
    writeChangeset('held-change.md', { '@arki/held': 'patch' });
    const envelope = await ship({ kind: 'start', wave: 'foundation', dryRun: false });
    expect(envelope.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.commitNeeded]);
    expect(calls.find(c => c.command.includes(' version'))?.command).not.toContain('--ignore @arki/held');
    expect(envelope.summary.next).toContain('.changeset/held-change.md');
  });

  it('dry run prints the plan and runs neither changeset version nor the build', async () => {
    // Why: agents run the dry run freely; it must leave the tree untouched.
    const envelope = await ship({ kind: 'start', wave: 'foundation', dryRun: true });
    expect(envelope.status).toBe('success');
    expect(envelope.items.find(i => i.id === 'version')?.status).toBe('planned');
    expect(calls.filter(c => c.via === 'exec')).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(root, 'packages', 'a', 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0' });
  });

  it('resume records doc examples and writes the packet', async () => {
    // Why: docs-fresh needs a producer, and the packet's publish lines must
    // name the frozen tarballs the checks ran on.
    const resumed = await ship({ kind: 'resume', wave: 'foundation', dryRun: false });
    const candidate = await candidateOf(resumed.summary.candidateDir ?? '');
    expect(candidate.checks['docs:@arki/a']).toMatchObject({ status: 'success', envelope: { kind: 'report' } });
    expect(candidate.checks['scorecard']?.status).toBe('success');
    const packet = readFileSync(resumed.summary.packet ?? '', 'utf8');
    expect(packet).toContain(`npm publish --access public ${path.join(resumed.summary.candidateDir ?? '', 'tarballs/arki-a-0.2.0.tgz')}`);
    expect(packet).toContain('npm view @arki/a@0.2.0 version dist.integrity');
    expect(packet).toContain('ship --finish --candidate');
  });

  it('resume runs each demo that uses the candidate and defers a demo that is not on disk', async () => {
    // Why: demo-impact passes only on a real candidate run. A broken demo is
    // recorded as a failure for the scorecard to judge, never hidden; a
    // demo absent from this clone is deferred, never faked as a pass.
    const demoDir = path.join(root, 'demos', 'shop');
    mkdirSync(path.join(demoDir, 'src'), { recursive: true });
    writeFileSync(path.join(demoDir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { 'arki:candidate': 'bun scripts/arki-deps.ts candidate' } }));
    writeFileSync(path.join(demoDir, 'arki.deps.json'), JSON.stringify({ linkRoot: '../../packages', packages: { '@arki/a': { path: 'a', version: '0.1.0' } } }));
    writeFileSync(path.join(demoDir, 'src', 'index.ts'), "import { a } from '@arki/a';\nexport { a };\n");
    const withDemos: ReleaseConfig = {
      ...config,
      demos: [
        { name: 'shop', repo: 'arki-labs/shop', path: 'demos/shop' },
        { name: 'absent', repo: 'arki-labs/absent', path: 'demos/absent' },
      ],
    };
    const resumed = await runShip({ cwd: root, config: withDemos, mode: { kind: 'resume', wave: 'foundation', dryRun: false }, deps: deps() });
    expect(calls.filter(c => c.command.includes('arki:candidate'))).toHaveLength(1);
    expect(resumed.items.filter(s => s.id.startsWith('demo:')).map(s => [s.id, s.status])).toEqual([
      ['demo:shop', 'failed'],
      ['demo:absent', 'deferred'],
    ]);
    const candidate = await candidateOf(resumed.summary.candidateDir ?? '');
    expect(candidate.checks['demo:shop']?.status).toBe('failure');
    expect(candidate.checks['demo:absent']?.status).toBe('deferred');
    // The stubbed scorecard is open, so the demo failure alone does not stop ship.
    expect(resumed.status).toBe('success');
  });

  it('writes no packet when the scorecard gate is blocked', async () => {
    // Why: the packet is what the founder publishes from; it must only exist for a passing candidate.
    const blocked: Partial<ShipDeps> = {
      scorecard: async () =>
        createEnvelope({
          command: 'scorecard',
          status: 'failure',
          summary: {
            message: 'blocked',
            totalPackages: 1,
            pass: 0,
            fail: 1,
            warn: 0,
            deferred: 0,
            stableReleaseGate: 'blocked',
            stableReleaseBlockers: ['@arki/a: docs-impact'],
            allowDeferred: false,
          },
        }),
    };
    const envelope = await ship({ kind: 'resume', wave: 'foundation', dryRun: false }, blocked);
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toContain(SHIP_ERROR_CODES.checksFailed);
    expect(existsSync(path.join(envelope.summary.candidateDir ?? '', 'packet.md'))).toBe(false);
  });
});

describe('ship --finish', () => {
  it('refuses inside an agent (CLAUDECODE) and without a TTY, before any npm call', async () => {
    // Why: --finish records a release and syncs the public mirror; only the founder may run it.
    const dir = freeze();
    const agent = await ship({ kind: 'finish', candidateDir: dir }, { env: { CLAUDECODE: '1' } });
    expect(agent.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.founderOnly]);
    const piped = await ship({ kind: 'finish', candidateDir: dir }, { isTTY: false });
    expect(piped.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.founderOnly]);
    expect(calls).toEqual([]);
  });

  it('skips a version already published with matching integrity, records shipped and the ledger', async () => {
    // Why: a rerun after a partial finish must not try to publish again (npm
    // forbids republishing) and must still complete the remaining steps.
    const dir = freeze();
    const candidate = await candidateOf(dir);
    published.set('@arki/a@0.2.0', integrityOf(candidate.packages[0]?.sha512 ?? ''));
    const synced: string[] = [];
    const envelope = await ship(
      { kind: 'finish', candidateDir: dir },
      { syncApply: async d => (synced.push(d), createEnvelope({ command: 'history', status: 'success', summary: {} })) },
    );
    expect(envelope.status).toBe('success');
    expect(envelope.items.find(i => i.id === 'verify:@arki/a')?.status).toBe('skipped');
    expect(calls.filter(c => c.via === 'npm').every(c => c.command.startsWith('npm view'))).toBe(true);
    const after = await candidateOf(dir);
    expect(after.checks['shipped']?.status).toBe('success');
    expect(synced).toEqual([dir]);
    const ledger = readFileSync(path.join(root, 'apps', 'arki', 'docs', 'RELEASES.md'), 'utf8');
    expect(ledger.indexOf('@arki/a | 0.2.0')).toBeLessThan(ledger.indexOf('## v0.0.1'));

    // A second run adds no second ledger entry.
    await ship({ kind: 'finish', candidateDir: dir });
    const again = readFileSync(path.join(root, 'apps', 'arki', 'docs', 'RELEASES.md'), 'utf8');
    expect(again.split('<!-- candidate: foundation-abcdef1 -->').length).toBe(2);
  });

  it('fails loudly on an integrity mismatch and records nothing as shipped', async () => {
    // Why: different bytes on npm than the ones that passed the checks is the
    // exact failure the candidate exists to catch; it must never look shipped.
    const dir = freeze();
    published.set('@arki/a@0.2.0', 'sha512-somethingElse==');
    const envelope = await ship({ kind: 'finish', candidateDir: dir });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.integrityMismatch]);
    expect((await candidateOf(dir)).checks['shipped']).toBeUndefined();
  });

  it('reports a version not yet on npm with its publish line, and does not publish it', async () => {
    // Why: finish verifies; publishing stays a founder act from the packet.
    const dir = freeze();
    const envelope = await ship({ kind: 'finish', candidateDir: dir });
    expect(envelope.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.notPublished]);
    expect(envelope.errors[0]?.remediation).toContain('npm publish --access public');
    expect(calls.filter(forbidden)).toEqual([]);
  });
});

describe('ship upgrade guide', () => {
  const stackConfig: ReleaseConfig = { ...config, tiers: { stack: ['@arki/a'], libraries: [] } };
  const shipStack = (dryRun: boolean, overrides: Partial<ShipDeps> = {}) =>
    runShip({ cwd: root, config: stackConfig, mode: { kind: 'start', wave: 'foundation', dryRun }, deps: deps(overrides) });
  const guideFile = () => path.join(root, 'packages', 'a', 'docs', 'upgrades', '0.1.0-to-0.2.0.md');
  const writeGuide = (text: string) => {
    mkdirSync(path.dirname(guideFile()), { recursive: true });
    writeFileSync(guideFile(), text);
  };

  it('fails GUIDE_E001 on a Stack minor bump without a guide, with the exact command', async () => {
    // Why: users upgrade a Stack package by its guide; shipping a minor with
    // none leaves them to read a changelog and guess.
    const dry = await shipStack(true);
    expect(dry.status).toBe('failure');
    expect(dry.errors.map(e => e.code)).toEqual(['GUIDE_E001']);
    expect(dry.errors[0]?.remediation).toContain('bun release:arki upgrade-guide --package @arki/a --from 0.1.0 --to 0.2.0 --write');
    const real = await shipStack(false);
    expect(real.errors.map(e => e.code)).toEqual(['GUIDE_E001']);
    // The real run writes the skeleton; npm has no 0.1.0 tarball here, so the API section keeps its marker.
    expect(real.errors[0]?.message).toContain('markers');
    expect(readFileSync(guideFile(), 'utf8')).toContain('<!-- upgrade:todo no api diff was available');
  });

  it('writes the skeleton with the API diff from the published tarball when it has api.json', async () => {
    // Why: removed and changed names are what users must act on; once the package
    // is built ship knows them, so nobody diffs the API by hand.
    const pkgDir = path.join(root, 'packages', 'a');
    const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ ...manifest, exports: { '.': { types: './dist/index.d.ts' } } }));
    mkdirSync(path.join(pkgDir, 'dist'));
    writeFileSync(path.join(pkgDir, 'dist', 'index.d.ts'), 'export declare function keep(): void;\nexport declare const added: 1;\n');
    const previous = {
      package: '@arki/a',
      version: '0.1.0',
      entries: [
        { subpath: '.', name: 'keep', kind: 'function', signature: 'export declare function keep(): void;', jsdocSummary: '' },
        { subpath: '.', name: 'old', kind: 'variable', signature: 'old: 1', jsdocSummary: '' },
      ],
      errorCodes: [],
    };
    const packed = path.join(root, 'prev', 'package');
    mkdirSync(path.join(packed, 'dist'), { recursive: true });
    writeFileSync(path.join(packed, 'package.json'), JSON.stringify({ name: '@arki/a', version: '0.1.0' }));
    writeFileSync(path.join(packed, 'dist', 'api.json'), JSON.stringify(previous));
    const tgz = path.join(root, 'prev', 'arki-a-0.1.0.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', path.join(root, 'prev'), 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const npm: ShipDeps['npm'] = async args => {
      calls.push({ via: 'npm', command: ['npm', ...args].join(' ') });
      if (args[0] === 'view' && args[2] === 'versions') return ok(JSON.stringify(['0.1.0']));
      if (args[0] !== 'pack' || args[1] !== '@arki/a@0.1.0') return { code: 1, stdout: '', stderr: 'npm error code E404' };
      copyFileSync(tgz, path.join(args[args.indexOf('--pack-destination') + 1] ?? '', 'arki-a-0.1.0.tgz'));
      return ok(JSON.stringify([{ filename: 'arki-a-0.1.0.tgz' }]));
    };
    const real = await shipStack(false, { npm });
    expect(real.errors.map(e => e.code)).toEqual(['GUIDE_E001']);
    const guide = readFileSync(guideFile(), 'utf8');
    expect(guide).toContain('Removed:\n- `old` from `@arki/a` (variable)');
    expect(guide).toContain('Added:\n- `added` from `@arki/a` (variable)');
    expect(guide).not.toContain('no api diff was available');
  });

  it('needs no guide for a Stack minor bump of a package npm has never seen', async () => {
    // Why: a first release has no users to migrate, so a guide would be noise
    // and blocking on it would stall every new package's first ship.
    released.clear();
    const dry = await shipStack(true);
    expect(dry.errors.map(e => e.code)).not.toContain('GUIDE_E001');
    expect(dry.items.find(step => step.id === 'upgrade-guide')?.status).toBe('skipped');
    expect(existsSync(guideFile())).toBe(false);
  });

  it('fails GUIDE_E001 while a skeleton marker is left, and passes once the guide is finished', async () => {
    // Why: a skeleton that ships unwritten is worse than no guide, because it
    // looks like documentation.
    writeGuide('# Upgrade\n\n<!-- upgrade:todo write the steps -->\n');
    const unfinished = await shipStack(true);
    expect(unfinished.errors.map(e => e.code)).toEqual(['GUIDE_E001']);
    expect(unfinished.errors[0]?.message).toContain('markers');
    writeGuide('# Upgrade @arki/a 0.1.0 to 0.2.0\n\nRename `x` to `y`.\n');
    const finished = await shipStack(true);
    expect(finished.status).toBe('success');
    expect(finished.items.find(i => i.id === 'upgrade-guide')?.status).toBe('done');
    const real = await shipStack(false);
    expect(real.errors.map(e => e.code)).toEqual([SHIP_ERROR_CODES.commitNeeded]);
  });

  it('does not ask for a guide for a patch bump or a package outside the Stack', async () => {
    // Why: guides are for Tier 1 minors only; demanding them elsewhere is noise.
    rmSync(path.join(root, '.changeset', 'a-feature.md'));
    writeChangeset('a-fix.md', { '@arki/a': 'patch' });
    const patch = await shipStack(true);
    expect(patch.status).toBe('success');
    expect(patch.items.find(i => i.id === 'upgrade-guide')?.status).toBe('skipped');
  });
});

async function candidateOf(dir: string): Promise<Candidate> {
  const read = await readCandidate(dir);
  if (!read.ok) throw new Error(read.errors.map(e => e.message).join('; '));
  return read.candidate;
}
