/**
 * Unit tests for the pack auditor.
 *
 * Strategy: feed synthetic `NpmPackEntry` fixtures into
 * {@link auditPackEntry} to exercise each rule independently. The
 * higher-level {@link auditPack} (which spawns npm) is exercised through
 * an injected runner so the tests stay deterministic and fast.
 */

import { describe, expect, it } from 'vitest';

import {
  auditPack,
  auditPackEntry,
  DEFAULT_PACK_RULES,
  runNpmPack,
} from './pack';
import type { NpmPackEntry, NpmPackFileEntry, PackAuditContext } from './types';

function makeEntry(files: ReadonlyArray<Partial<NpmPackFileEntry>>): NpmPackEntry {
  const fileEntries: NpmPackFileEntry[] = files.map(f => ({
    path: f.path ?? 'file.js',
    size: f.size ?? 100,
    mode: f.mode ?? 0o644,
  }));
  return {
    id: 'pkg@1.0.0',
    name: 'pkg',
    version: '1.0.0',
    filename: 'pkg-1.0.0.tgz',
    files: fileEntries,
    entryCount: fileEntries.length,
    bundled: [],
    size: 1000,
    unpackedSize: fileEntries.reduce((a, b) => a + b.size, 0),
  };
}

const ctx: PackAuditContext = {
  packageDir: '/tmp/pkg',
  manifest: { name: 'pkg', version: '1.0.0' },
  isSourceDistributed: false,
};
const srcCtx: PackAuditContext = { ...ctx, isSourceDistributed: true };

describe('auditPackEntry — happy path', () => {
  it('passes on a well-formed entry (.js, .d.ts, README, LICENSE)', () => {
    const entry = makeEntry([
      { path: 'dist/index.js' },
      { path: 'dist/index.d.ts' },
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    expect(result.status).toBe('pass');
    expect(result.ruleHits).toHaveLength(0);
  });
});

describe('auditPackEntry — error rules', () => {
  it('flags raw TypeScript when not source-distributed', () => {
    const entry = makeEntry([
      { path: 'src/foo.ts' },
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    expect(result.status).toBe('fail');
    const rawTsHit = result.ruleHits.find(h => h.ruleId === 'no-raw-ts');
    expect(rawTsHit?.severity).toBe('error');
  });

  it('allows raw TypeScript when source-distributed', () => {
    const entry = makeEntry([
      { path: 'src/foo.ts' },
      { path: 'src/foo.d.ts' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, srcCtx);
    const rawTsHit = result.ruleHits.find(h => h.ruleId === 'no-raw-ts');
    expect(rawTsHit).toBeUndefined();
  });

  it('flags .d.ts files as NOT raw TS', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const rawTsHit = result.ruleHits.find(h => h.ruleId === 'no-raw-ts');
    expect(rawTsHit).toBeUndefined();
  });

  it('flags .test.ts files', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.test.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'no-tests');
    expect(hit?.severity).toBe('error');
  });

  it('flags __tests__/ dir entries', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: '__tests__/foo.js' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'no-tests');
    expect(hit?.severity).toBe('error');
  });

  it('flags private docs', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'docs/internal/secret.md' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'no-private-docs');
    expect(hit?.severity).toBe('error');
  });

  it('flags missing compiled JS when not source-distributed', () => {
    const entry = makeEntry([
      { path: 'dist/foo.d.ts' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'requires-compiled');
    expect(hit?.severity).toBe('error');
  });

  it('does not flag missing compiled JS when source-distributed', () => {
    const entry = makeEntry([
      { path: 'src/foo.ts' },
      { path: 'src/foo.d.ts' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, srcCtx);
    const hit = result.ruleHits.find(h => h.ruleId === 'requires-compiled');
    expect(hit).toBeUndefined();
  });

  it('flags missing .d.ts', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'requires-declarations');
    expect(hit?.severity).toBe('error');
  });

  it('flags .env files', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: '.env' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'no-env-files');
    expect(hit?.severity).toBe('error');
  });

  it('flags node_modules leaks', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'dist/node_modules/lib/index.js' },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'no-node-modules');
    expect(hit?.severity).toBe('error');
  });
});

describe('auditPackEntry — warning rules', () => {
  it('warns on files larger than 1MB', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'dist/huge.json', size: 2_000_000 },
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'no-large-files');
    expect(hit?.severity).toBe('warning');
    expect(result.status).toBe('warn');
  });

  it('warns when README is missing', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'requires-readme');
    expect(hit?.severity).toBe('warning');
  });

  it('warns when LICENSE is missing', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'README.md' },
    ]);
    const result = auditPackEntry(entry, ctx);
    const hit = result.ruleHits.find(h => h.ruleId === 'requires-license');
    expect(hit?.severity).toBe('warning');
  });
});

describe('auditPackEntry — status aggregation', () => {
  it('returns "fail" when any error rule hits', () => {
    const entry = makeEntry([
      { path: 'src/foo.ts' }, // raw ts — error
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'huge.bin', size: 2_000_000 }, // warning
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    expect(result.status).toBe('fail');
  });

  it('returns "warn" when only warnings hit', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js' },
      { path: 'dist/foo.d.ts' },
      { path: 'huge.bin', size: 2_000_000 }, // warning
      { path: 'README.md' },
      { path: 'LICENSE' },
    ]);
    const result = auditPackEntry(entry, ctx);
    expect(result.status).toBe('warn');
  });

  it('totals report file count + size correctly', () => {
    const entry = makeEntry([
      { path: 'dist/foo.js', size: 100 },
      { path: 'dist/foo.d.ts', size: 50 },
      { path: 'README.md', size: 10 },
      { path: 'LICENSE', size: 20 },
    ]);
    const result = auditPackEntry(entry, ctx);
    expect(result.totals.fileCount).toBe(4);
    expect(result.totals.unpackedSize).toBe(180);
  });
});

describe('runNpmPack with injected runner', () => {
  it('parses valid npm pack JSON output', async () => {
    const fakeOutput = JSON.stringify([
      {
        id: 'pkg@1.0.0',
        name: 'pkg',
        version: '1.0.0',
        filename: 'pkg-1.0.0.tgz',
        files: [
          { path: 'dist/index.js', size: 100, mode: 0o644 },
          { path: 'dist/index.d.ts', size: 50, mode: 0o644 },
        ],
        entryCount: 2,
        bundled: [],
        size: 1000,
        unpackedSize: 150,
      },
    ]);
    const result = await runNpmPack('/tmp/pkg', {
      runner: () => Promise.resolve({ stdout: fakeOutput, stderr: '', code: 0 }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.name).toBe('pkg');
      expect(result.entries[0]?.files).toHaveLength(2);
    }
  });

  it('reports non-zero exit codes as failure', async () => {
    const result = await runNpmPack('/tmp/pkg', {
      runner: () => Promise.resolve({ stdout: '', stderr: 'oops', code: 1 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('exited with code 1');
  });

  it('reports unparseable JSON as failure', async () => {
    const result = await runNpmPack('/tmp/pkg', {
      runner: () => Promise.resolve({ stdout: 'not json', stderr: '', code: 0 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('reports non-array output as failure', async () => {
    const result = await runNpmPack('/tmp/pkg', {
      runner: () => Promise.resolve({ stdout: '{}', stderr: '', code: 0 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an array');
  });
});

describe('auditPack — end-to-end with injected runner', () => {
  it('produces a pass result for a clean entry', async () => {
    const fakeOutput = JSON.stringify([
      {
        id: 'pkg@1.0.0',
        name: 'pkg',
        version: '1.0.0',
        filename: 'pkg-1.0.0.tgz',
        files: [
          { path: 'dist/index.js', size: 100, mode: 0o644 },
          { path: 'dist/index.d.ts', size: 50, mode: 0o644 },
          { path: 'README.md', size: 10, mode: 0o644 },
          { path: 'LICENSE', size: 20, mode: 0o644 },
        ],
        entryCount: 4,
        bundled: [],
        size: 1000,
        unpackedSize: 180,
      },
    ]);
    const result = await auditPack('/tmp/pkg', {
      manifest: { name: 'pkg', version: '1.0.0' },
      isSourceDistributed: false,
      runner: () => Promise.resolve({ stdout: fakeOutput, stderr: '', code: 0 }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe('pass');
      expect(result.result.package.name).toBe('pkg');
    }
  });

  it('surfaces npm pack invocation failures as `ok: false`', async () => {
    const result = await auditPack('/tmp/pkg', {
      manifest: { name: 'pkg', version: '1.0.0' },
      isSourceDistributed: false,
      runner: () => Promise.resolve({ stdout: '', stderr: 'boom', code: 1 }),
    });
    expect(result.ok).toBe(false);
  });
});

describe('DEFAULT_PACK_RULES contract', () => {
  it('exports a non-empty rule list', () => {
    expect(DEFAULT_PACK_RULES.length).toBeGreaterThan(0);
  });

  it('all rules have unique ids', () => {
    const ids = DEFAULT_PACK_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
