/**
 * Help and --version must work when a command's module is slow, broken or
 * needs a database: they import at most one lazy level below the asked path
 * and never run a command. The fixture counts every lazy import.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FixtureTree from './__fixtures__/tree.js';
import { capture } from './__fixtures__/capture.js';

let fixture: typeof FixtureTree;

beforeEach(async () => {
  // A fresh module registry per test: the import counter and every lazy module start unloaded.
  vi.resetModules();
  fixture = await import('./__fixtures__/tree.js');
});

describe('--version', () => {
  it('prints the version and imports nothing lazy', async () => {
    const result = await capture(fixture.fixtureCli(), ['--version']);
    expect(result).toEqual({ exitCode: 0, stdout: '1.2.3\n', stderr: '' });
    expect([...fixture.imports.keys()]).toEqual([]);
  });

  it('wins over a command path, so a broken branch cannot break it', async () => {
    const result = await capture(fixture.fixtureCli(), ['admin', 'broken', '--version']);
    expect(result.exitCode).toBe(0);
    expect(fixture.imports.size).toBe(0);
  });
});

describe('--help', () => {
  it('root help lists the children one level down and never imports the broken module two levels down', async () => {
    const { exitCode, stdout } = await capture(fixture.fixtureCli(), ['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('A lazy fixture');
    expect(stdout).toMatch(/admin\s+Administration/);
    expect(stdout).toMatch(/seed\s+Seed embeddings/);
    expect(stdout).not.toContain('broken');
    expect(fixture.imports.has('broken')).toBe(false);
  });

  it('command help imports only that command, never a sibling such as seed', async () => {
    const { exitCode, stdout } = await capture(fixture.fixtureCli(), ['bench', 'run', '--help']);
    expect(exitCode).toBe(0);
    expect([...fixture.imports.keys()]).toEqual(['bench']);
    expect(stdout).toContain('Usage: fixture bench run [options]');
    expect(stdout).toMatch(/--label <string>\s+Name of this run \(default: "latest"\)/);
    expect(stdout).toMatch(
      /--category <reference-fidelity\|refusal\|routing\|historical\|pastoral\|fairness>.*repeatable/,
    );
    expect(stdout).toContain('-o, --output <auto|text|json|ndjson>');
    expect(stdout).toContain('fixture bench run --label nightly --category refusal');
  });

  it('command help shows a positional with its type', async () => {
    const { stdout } = await capture(fixture.fixtureCli(), ['seed', '-h']);
    expect(stdout).toContain('Usage: fixture seed [<max-batches>] [options]');
    expect(stdout).toMatch(/\[<max-batches>\]\s+Stop after this many batches \(integer\)/);
  });

  it('a group asked for help one level above a broken module reports it instead of failing', async () => {
    const { exitCode, stdout } = await capture(fixture.fixtureCli(), ['admin', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/broken\s+\(failed to load\)/);
  });

  it('a group without a command prints its help', async () => {
    const { exitCode, stdout } = await capture(fixture.fixtureCli(), ['ping']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/now\s+Answer now/);
  });
});
