/**
 * Committed-state snapshot for `export-public`.
 *
 * The exporter reads `packages/**`, the root `package.json` (catalogs) and
 * `arki.release.config.ts`. Reading them from the working tree lets a
 * sibling session's uncommitted edits (an unpublished version bump, a
 * package dropped from a wave) leak into the public tree. A snapshot of a
 * git ref holds only committed content.
 *
 * Build output is gitignored, so `dist/` is copied over from the working
 * tree — but only for packages whose tracked files match the ref. A
 * package with uncommitted changes gets no `dist/`: its build may reflect
 * the uncommitted source. Those packages are reported in `dirtyPackages`.
 * Markdown edits do not count: no build reads them, and the snapshot
 * already ships the committed README.
 */

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import debugFactory from 'debug';

const debug = debugFactory('arki:release:snapshot');
const run = promisify(execFile);

/** Everything the exporter reads from the repository root. */
const SNAPSHOT_PATHS = ['packages', 'package.json', 'arki.release.config.ts'] as const;
const BUILD_OUTPUT_DIR = 'dist';

export type SourceSnapshot = {
  /** Directory holding the committed files; pass it as the exporter's `sourceRoot`. */
  readonly dir: string;
  /** The commit the snapshot was taken from. */
  readonly commit: string;
  /** Package dirs (`packages/...`) with uncommitted non-Markdown changes; they get no `dist/`. */
  readonly dirtyPackages: readonly string[];
  readonly cleanup: () => Promise<void>;
};

export type SnapshotOptions = {
  readonly rootCwd: string;
  /** Git ref to snapshot. Default `HEAD`. */
  readonly ref?: string;
};

export async function createSourceSnapshot(options: SnapshotOptions): Promise<SourceSnapshot> {
  const { rootCwd } = options;
  const ref = options.ref ?? 'HEAD';
  const resolved = await git(rootCwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const commit = resolved.trim();
  const dir = await mkdtemp(path.join(tmpdir(), 'arki-release-snapshot-'));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });

  try {
    const archive = path.join(dir, '.snapshot.tar');
    await git(rootCwd, ['archive', '--format=tar', `--output=${archive}`, commit, '--', ...SNAPSHOT_PATHS]);
    await run('tar', ['-xf', archive, '-C', dir]);
    await rm(archive);

    const dirtyPackages = await overlayBuildOutput(rootCwd, dir, commit);
    debug('snapshot %s of %s at %s (%d dirty packages)', commit, ref, dir, dirtyPackages.length);
    return { dir, commit, dirtyPackages, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Repo-relative paths that differ from `commit`: changed tracked files plus untracked, non-ignored ones. */
async function changedFiles(rootCwd: string, commit: string): Promise<readonly string[]> {
  const changed = await git(rootCwd, ['diff', '--name-only', commit, '--', 'packages']);
  const untracked = await git(rootCwd, ['ls-files', '--others', '--exclude-standard', '--', 'packages']);
  return `${changed}\n${untracked}`.split('\n').filter(file => file.length > 0);
}

/** Every directory under `packages/` in the snapshot that holds a `package.json`, repo-relative. */
async function packageDirs(snapshotDir: string): Promise<readonly string[]> {
  const entries = await readdir(path.join(snapshotDir, 'packages'), { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter(entry => entry.isFile() && entry.name === 'package.json')
    .map(entry => path.relative(snapshotDir, entry.parentPath).split(path.sep).join('/'));
}

/**
 * Copies `dist/` from the working tree into the snapshot for every package
 * whose files match the commit, and returns the packages that do not.
 */
async function overlayBuildOutput(rootCwd: string, snapshotDir: string, commit: string): Promise<string[]> {
  const changed = await changedFiles(rootCwd, commit);
  const dirty: string[] = [];
  for (const relative of await packageDirs(snapshotDir)) {
    if (changed.some(file => file.startsWith(`${relative}/`) && !file.endsWith('.md'))) {
      dirty.push(relative);
      continue;
    }
    const from = path.join(rootCwd, relative, BUILD_OUTPUT_DIR);
    if (!(await isDirectory(from))) continue;
    await cp(from, path.join(snapshotDir, relative, BUILD_OUTPUT_DIR), { recursive: true });
  }
  return dirty.toSorted();
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}
