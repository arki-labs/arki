/**
 * `site` copies package docs from published bytes into the arki site.
 * Fixtures are real `.tgz` files in temp dirs; npm and the dot CLI are fakes.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecRunner, NpmRunner, RunOutput } from './runners';
import type { ReleaseConfig } from './types';
import {
  compareVersions,
  REPO_DOC_COPIES,
  runSite,
  SITE_APP_CONTENT_DIR,
  SITE_CONTENT_DIR,
  SITE_ERROR_CODES,
  SITE_GENERATED_DIR,
} from './site';
import {
  demosFileSchema,
  dotNewFileSchema,
  errorsFileSchema,
  examplesFileSchema,
  packagesFileSchema,
  snapshotMetaSchema,
} from './site-schema';
import { renderSiteSchemaCopy, SITE_SCHEMA_COPY_FILE } from './site-schema-copy';

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
    { id: 'foundation', label: 'Foundation', packages: ['@arki/a'] },
    { id: 'dot-kernel', label: 'Kernel', packages: ['@arki/dot'] },
  ],
};

type Files = Readonly<Record<string, string>>;

const README_ONLY: Files = {
  'package.json': JSON.stringify({ name: '@arki/a', version: '0.1.0' }),
  'README.md': '# a\n',
  'CHANGELOG.md': '## 0.1.0\n',
  'dist/index.js': 'export {};\n',
  'src/index.ts': 'export {};\n',
};

const WITH_DOCS: Files = {
  'package.json': JSON.stringify({ name: '@arki/a', version: '0.2.0', license: 'Apache-2.0', engines: { node: '>=22' } }),
  'README.md': '# a\n',
  'CHANGELOG.md': '## 0.2.0\n',
  'llms.txt': '# a\n',
  'AGENTS.md': '# agents\n',
  'docs/agent-guide.md': '# guide\n',
  'dist/index.js': 'export {};\n',
  'dist/api.json': '{}\n',
  'dist/errors.json': JSON.stringify([
    { code: 'A_E001', package: '@arki/a', kind: 'thrown', what: 'boom', fix: null, verify: null, source: 'src/a.ts:1' },
  ]),
};

const REPORT = { examples: 3, modules: 1, compiled: 3, ran: 2, skipped: 1, skippedBlocks: [], failures: [] };

let root: string;
/** The site's start app: another repo, so a folder apart from `root`. */
let out: string;
let packCalls: string[];
/** What `npm pack <name>@<version>` returns, keyed `name@version`. */
let registry: Map<string, Files>;

/** The repo docs every run copies; tests that are not about them get them all. */
function writeRepoDocs(root: string): void {
  for (const doc of REPO_DOC_COPIES) {
    mkdirSync(path.dirname(path.join(root, doc.from)), { recursive: true });
    writeFileSync(path.join(root, doc.from), `# ${doc.from}\n`);
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-site-'));
  out = mkdtempSync(path.join(tmpdir(), 'arki-site-out-'));
  mkdirSync(path.join(out, 'src'));
  packCalls = [];
  registry = new Map();
  writeRepoDocs(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

function makeTgz(dir: string, filename: string, files: Files): string {
  const stage = mkdtempSync(path.join(tmpdir(), 'arki-site-tgz-'));
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(stage, 'package', file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, filename);
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  rmSync(stage, { recursive: true, force: true });
  return tgz;
}

const ok = (stdout: string): RunOutput => ({ code: 0, stdout, stderr: '' });

const npm: NpmRunner = async args => {
  if (args[0] === 'view') {
    const versions = [...registry.keys()]
      .filter(key => key.startsWith(`${args[1] ?? ''}@`))
      .map(key => key.split('@').at(-1) ?? '');
    return versions.length === 0
      ? { code: 1, stdout: '', stderr: 'npm error code E404' }
      : ok(JSON.stringify(versions));
  }
  const spec = args[1] ?? '';
  packCalls.push(spec);
  const files = registry.get(spec);
  if (files === undefined) return { code: 1, stdout: '', stderr: 'not found' };
  const filename = `${spec.replace(/^@/, '').replace(/[/@]/g, '-')}.tgz`;
  makeTgz(args[4] ?? '', filename, files);
  return ok(JSON.stringify([{ filename }]));
};

/** Freezes a candidate the way `candidate` does: tarballs + sha512 + checks. */
function writeCandidate(
  dirName: string,
  wave: string,
  createdAt: string,
  packages: Record<string, { version: string; files: Files }>,
): string {
  const dir = path.join(root, '.release', 'candidates', dirName);
  const entries = Object.entries(packages).map(([name, { version, files }], i) => {
    const tgz = makeTgz(path.join(dir, 'tarballs'), `${name.replace('@arki/', 'arki-')}-${version}.tgz`, files);
    const sha512 = createHash('sha512').update(readFileSync(tgz)).digest('hex');
    return { name, version, tarball: path.join('tarballs', path.basename(tgz)), sha512, publishOrder: i + 1 };
  });
  const checks = Object.fromEntries(
    Object.keys(packages).map(name => [
      `docs:${name}`,
      { status: 'success', at: createdAt, envelope: { kind: 'report', report: REPORT } },
    ]),
  );
  writeFileSync(
    path.join(dir, 'candidate.json'),
    JSON.stringify({ wave, sourceCommit: 'abcdef1234567890', createdAt, packages: entries, checks }),
  );
  return dir;
}

const content = (...parts: string[]): string => path.join(out, SITE_CONTENT_DIR, ...parts);
const generated = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(out, SITE_GENERATED_DIR, file), 'utf8'));

describe('site --channel published', () => {
  it('never rewrites a published version folder: npm bytes are immutable, so the page is too', async () => {
    registry.set('@arki/a@0.2.0', WITH_DOCS);
    const first = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(first.summary.created).toBe(1);

    // Even if the registry answered differently, the existing snapshot stays as written.
    registry.set('@arki/a@0.2.0', { ...WITH_DOCS, 'README.md': '# changed\n' });
    const second = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(second.summary.created).toBe(0);
    expect(second.summary.kept).toBe(1);
    expect(packCalls).toEqual(['@arki/a@0.2.0']);
    expect(readFileSync(content('a', '0.2.0', 'README.md'), 'utf8')).toBe('# a\n');
  });

  it('keeps README + CHANGELOG only from a tarball without docs, and marks it archive', async () => {
    registry.set('@arki/a@0.1.0', README_ONLY);
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(envelope.items).toContainEqual({
      name: '@arki/a',
      version: '0.1.0',
      channel: 'published',
      action: 'created',
      archive: true,
    });
    // Never code: no dist/ or src/ reaches the site.
    expect(existsSync(content('a', '0.1.0', 'dist'))).toBe(false);
    expect(existsSync(content('a', '0.1.0', 'src'))).toBe(false);
    const [entry] = packagesFileSchema.parse(generated('packages.json'));
    expect(entry).toMatchObject({
      name: '@arki/a',
      status: 'archive',
      npmVersion: '0.1.0',
      versions: [{ version: '0.1.0', archive: true }],
    });
  });

  it('serves the newest published version when its snapshot has docs, with its error codes', async () => {
    registry.set('@arki/a@0.1.0', README_ONLY);
    registry.set('@arki/a@0.2.0', WITH_DOCS);
    await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    // Docs go in; the indexes move out of dist/ under their own names.
    expect(readFileSync(content('a', '0.2.0', 'docs', 'agent-guide.md'), 'utf8')).toBe('# guide\n');
    expect(existsSync(content('a', '0.2.0', 'api.json'))).toBe(true);
    expect(existsSync(content('a', '0.2.0', 'dist'))).toBe(false);
    const [entry] = packagesFileSchema.parse(generated('packages.json'));
    expect(entry).toMatchObject({
      status: 'published',
      npmVersion: '0.2.0',
      hasLlms: true,
      runtimes: { node: '>=22' },
    });
    expect(errorsFileSchema.parse(generated('errors.json'))).toEqual([
      expect.objectContaining({ code: 'A_E001', version: '0.2.0', channel: 'published' }),
    ]);
  });
});

describe('site retired packages', () => {
  it('removes the docs of a package that left the config: the site build rejects docs missing from packages.json', async () => {
    registry.set('@arki/a@0.2.0', WITH_DOCS);
    for (const version of ['0.1.0', 'next']) {
      mkdirSync(content('gone', version), { recursive: true });
      writeFileSync(content('gone', version, 'README.md'), '# gone\n');
    }
    const result = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });

    expect(existsSync(content('gone'))).toBe(false);
    expect(existsSync(content('a', '0.2.0', 'README.md'))).toBe(true);
    expect(result.summary.removed).toBe(2);
    expect(result.items.filter(item => item.action === 'removed').map(item => item.name)).toEqual([
      '@arki/gone',
      '@arki/gone',
    ]);
  });
});

describe('site --channel next', () => {
  it('rewrites next/ every run and shows it as latest while npm only has an archive', async () => {
    registry.set('@arki/a@0.1.0', README_ONLY);
    await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    writeCandidate('foundation-aaaaaaa', 'foundation', '2026-10-20T00:00:00.000Z', {
      '@arki/a': { version: '0.2.0', files: { ...WITH_DOCS, 'docs/old.md': '# old\n' } },
    });
    await runSite({ cwd: root, outDir: out, config, channel: 'next', npmRunner: npm });
    expect(existsSync(content('a', 'next', 'docs', 'old.md'))).toBe(true);

    // A newer candidate replaces the folder: files it no longer ships disappear.
    writeCandidate('foundation-bbbbbbb', 'foundation', '2026-10-21T00:00:00.000Z', {
      '@arki/a': { version: '0.2.1', files: WITH_DOCS },
    });
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'next', npmRunner: npm });
    expect(existsSync(content('a', 'next', 'docs', 'old.md'))).toBe(false);
    expect(envelope.summary.wavesWithoutCandidate).toEqual(['dot-kernel']);
    expect(envelope.errors.map(e => e.code)).toContain(SITE_ERROR_CODES.noCandidate);

    const [entry] = packagesFileSchema.parse(generated('packages.json'));
    expect(entry).toMatchObject({
      status: 'next',
      npmVersion: '0.1.0',
      nextVersion: '0.2.1',
      candidate: { wave: 'foundation', createdAt: '2026-10-21T00:00:00.000Z' },
      examples: { compiled: 3, run: 2, skipped: 1 },
    });
    expect(examplesFileSchema.parse(generated('examples.json'))).toEqual([
      { name: '@arki/a', version: '0.2.1', report: REPORT },
    ]);
    expect(demosFileSchema.parse(generated('demos.json'))).toEqual([]);
    // The license comes from the package's own package.json in the tarball, not from a constant.
    expect(snapshotMetaSchema.parse(JSON.parse(readFileSync(content('a', 'next', 'snapshot.json'), 'utf8'))).license).toBe(
      'Apache-2.0',
    );
    expect(snapshotMetaSchema.parse(JSON.parse(readFileSync(content('a', '0.1.0', 'snapshot.json'), 'utf8'))).license).toBeNull();
    // The published archive is still there, untouched by the next run.
    expect(readFileSync(content('a', '0.1.0', 'README.md'), 'utf8')).toBe('# a\n');
  });

  it('ignores a candidate whose tarball changed after it was frozen', async () => {
    const dir = writeCandidate('foundation-aaaaaaa', 'foundation', '2026-10-20T00:00:00.000Z', {
      '@arki/a': { version: '0.2.0', files: WITH_DOCS },
    });
    makeTgz(path.join(dir, 'tarballs'), 'arki-a-0.2.0.tgz', { ...WITH_DOCS, 'docs/evil.md': '# not reviewed\n' });
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'next', npmRunner: npm });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toContain(SITE_ERROR_CODES.candidateUnreadable);
    expect(existsSync(content('a', 'next'))).toBe(false);
  });

  it("plans dot new from the candidate's CLI and stores the target relative to where it ran", async () => {
    writeCandidate('dot-kernel-ccccccc', 'dot-kernel', '2026-10-21T00:00:00.000Z', {
      '@arki/dot': {
        version: '0.7.0',
        files: { ...WITH_DOCS, 'package.json': JSON.stringify({ name: '@arki/dot', version: '0.7.0' }) },
      },
    });
    const calls: string[] = [];
    const exec: ExecRunner = async (command, args, { cwd }) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'npm') return ok('');
      const template = args[args.indexOf('--template') + 1] ?? '';
      const data = {
        app: { name: 'arki-app', target: path.join(cwd, 'arki-app') },
        operations: [{ path: `${template}.ts`, action: 'create', contentHash: 'x', contentBytes: 1, reason: 'r' }],
        nextSteps: [],
      };
      return ok(JSON.stringify({ ok: true, command: ['new'], data }));
    };
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'next', npmRunner: npm, exec, tmpRoot: root });
    expect(envelope.summary.dotNew).toBe('written');
    // Installed from the frozen tarball, not linked from source.
    const consumer = calls[0] ?? '';
    expect(consumer).toBe('npm install --no-audit --no-fund');
    const file = dotNewFileSchema.parse(generated('dot-new.json'));
    expect(file.version).toBe('0.7.0');
    expect(file.templates.map(t => [t.template, t.result.app.target])).toEqual([
      ['minimal', 'arki-app'],
      ['stack', 'arki-app'],
    ]);
  });
});

describe('site repo docs', () => {
  const appContent = (...parts: string[]): string => path.join(out, SITE_APP_CONTENT_DIR, ...parts);

  // The Docker image is built from `turbo prune` output, which has no repo-root `docs/` or `SECURITY.md`. The site
  // can only show these files if `site` keeps copies inside the app.
  it('copies the glossary (with its source line), the bench protocol and SECURITY.md into the app', async () => {
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(envelope.summary.repoDocs).toBe(REPO_DOC_COPIES.length);
    expect(readFileSync(appContent('glossary', 'glossary.md'), 'utf8')).toBe(
      '---\nsource: docs/arki/glossary.md\n---\n\n# docs/arki/glossary.md\n',
    );
    expect(readFileSync(appContent('agent-bench', 'PROTOCOL.md'), 'utf8')).toBe(
      '# docs/arki/agent-bench/PROTOCOL.md\n',
    );
    expect(readFileSync(appContent('security', 'SECURITY.md'), 'utf8')).toBe('# SECURITY.md\n');
  });

  // results.json exists only after a benchmark run; a stale copy would show numbers the repo no longer has.
  it('removes the results copy when the repo has none', async () => {
    await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    rmSync(path.join(root, 'docs/arki/agent-bench/results.json'));
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(envelope.status).toBe('success');
    expect(existsSync(appContent('agent-bench', 'results.json'))).toBe(false);
  });

  // A page with no glossary must stop the run, not ship an empty one.
  it('fails when a required repo doc is missing', async () => {
    rmSync(path.join(root, 'docs/arki/glossary.md'));
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toContain(SITE_ERROR_CODES.repoDocMissing);
  });
});

describe('site --out', () => {
  // The site lives in the private workspace repo: everything goes under --out, and the app reads its types from a
  // copy it can compile without this repo's packages.
  it('writes the data and the self-contained schema copy under --out, and nothing into the arki repo', async () => {
    registry.set('@arki/a@0.2.0', WITH_DOCS);
    const envelope = await runSite({ cwd: root, outDir: out, config, channel: 'published', npmRunner: npm });
    expect(envelope.status).toBe('success');
    expect(readFileSync(path.join(out, SITE_SCHEMA_COPY_FILE), 'utf8')).toBe(renderSiteSchemaCopy());
    expect(existsSync(path.join(out, SITE_GENERATED_DIR, 'packages.json'))).toBe(true);
    expect(existsSync(path.join(root, 'src'))).toBe(false);
    expect(existsSync(path.join(root, 'apps'))).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders numerically and puts a prerelease before its release', () => {
    expect(['0.10.0', '0.2.0', '0.2.0-beta.1', '1.0.0'].toSorted(compareVersions)).toEqual([
      '0.2.0-beta.1',
      '0.2.0',
      '0.10.0',
      '1.0.0',
    ]);
  });
});
