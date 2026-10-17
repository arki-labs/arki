/**
 * Deterministic file copy primitives for the public-tree exporter.
 *
 * This module owns the "what does a published package ship?" contract:
 *
 *   - {@link DEFAULT_FILE_EXCLUDES} — patterns that never make it into the
 *     output tree (workspace artifacts, env files, tests, internal docs).
 *   - {@link DEFAULT_FILE_INCLUDES} — patterns we always try to include
 *     when present in the source (`README.md`, `LICENSE`, `dist/**`).
 *   - The npm `package.json#files` array — when present, it joins the
 *     include list. This is npm's canonical "what gets published" contract.
 *
 * The exclusion list is enforced first: a path matched by an exclude
 * pattern is dropped even if an include or `files` entry would have kept
 * it. This matches the spirit of `.npmignore` and prevents accidental
 * leaks (e.g. a vendored `node_modules/` inside a package source dir).
 *
 * Determinism discipline:
 *   - Directory walks are deterministic via `readdir` + lexicographic
 *     sort on entry names before recursing.
 *   - The returned copy plan is sorted by `dest`, so two runs over the
 *     same source produce byte-identical output (modulo mtime, which we
 *     intentionally do not preserve).
 *   - No glob libraries — we hand-roll a small matcher to keep the
 *     dependency surface tight and the behaviour auditable.
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';

const debug = debugFactory('arki:release:files');

/**
 * Patterns that are NEVER copied into a published package.
 *
 * These are evaluated against the workspace-relative path of every file
 * discovered inside a package source directory. A match drops the file.
 *
 * Categories:
 *   - Workspace build/cache artifacts (`node_modules`, `.turbo`, `.cache`).
 *   - Version control (`.git`).
 *   - Local environment / secrets (`.env`, `.env.*`).
 *   - Test files (npm pack auditor catches these too; we exclude here for
 *     belt-and-braces protection).
 *   - Internal docs trees (the leak scanner catches leaked content; this
 *     just keeps internal research out of the public tree wholesale).
 *   - Build outputs that aren't `dist` (`.next`, `build`, `out`).
 *   - Editor / OS noise.
 *   - Internal scratchpads (`.scratch`, `.agents`).
 */
export const DEFAULT_FILE_EXCLUDES: readonly string[] = [
  // Workspace artifacts
  'node_modules/**',
  '.turbo/**',
  '.cache/**',
  'coverage/**',
  // VCS
  '.git/**',
  // Local env / secrets
  '.env',
  '.env.*',
  // Test files
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '__tests__/**',
  'tests/**',
  // Internal docs (the leak scanner catches public-facing leaks; here we
  // exclude internal docs dirs wholesale).
  'docs/internal/**',
  'docs/private/**',
  'docs/research/**',
  // Build outputs that aren't dist
  '.next/**',
  'build/**',
  'out/**',
  // Editor metadata
  '.vscode/**',
  '.idea/**',
  '*.swp',
  // OS noise
  '.DS_Store',
  'Thumbs.db',
  // Internal scratchpads
  '.scratch/**',
  '.agents/**',
];

/**
 * Patterns we ALWAYS try to include when present in source, in addition
 * to whatever `package.json#files` says.
 *
 * The intent: even if a package author forgets to list `README.md` /
 * `LICENSE` in their `files`, npm convention says these still ship.
 * Compiled output (`dist/**`), source maps, and type declarations follow
 * the same logic.
 */
export const DEFAULT_FILE_INCLUDES: readonly string[] = [
  'README.md',
  'README.mdx',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
  'package.json',
  // Compiled output trees.
  'dist/**',
  // TypeScript source — shipped in both the GitHub mirror and npm
  // tarballs so consumers can step into source maps and inspect the
  // implementation without spelunking through compiled artifacts.
  // The exclude list above strips test files (`*.test.ts`, `*.spec.ts`,
  // `__tests__/**`, `tests/**`) so they don't leak through this glob.
  'src/**',
  // TypeScript configuration — useful for downstream IDE navigation
  // and for consumers building from source.
  'tsconfig.json',
  'tsconfig.*.json',
  // Source maps.
  '**/*.map',
  // Type declarations.
  '**/*.d.ts',
  '**/*.d.cts',
  '**/*.d.mts',
];

/**
 * A single entry in a deterministic copy plan.
 *
 * `src` and `dest` are both absolute paths so the executor doesn't need
 * a cwd. `size` is captured at plan-build time so the caller can report
 * a total without re-stating every file.
 */
export interface CopyPlanEntry {
  readonly src: string;
  readonly dest: string;
  readonly size: number;
}

/** Options accepted by {@link buildCopyPlan}. */
export interface BuildCopyPlanOptions {
  readonly packageSourceDir: string;
  readonly packageDestDir: string;
  /** The input package.json `files` array, if any. */
  readonly manifestFiles?: readonly string[];
  /** Defaults to {@link DEFAULT_FILE_INCLUDES}. */
  readonly includes?: readonly string[];
  /** Defaults to {@link DEFAULT_FILE_EXCLUDES}. */
  readonly excludes?: readonly string[];
}

/**
 * Build a deterministic copy plan for a single package's source tree.
 *
 * The walk:
 *   1. Discover every file under `packageSourceDir` (sorted).
 *   2. Drop any file whose source-relative path matches an exclude pattern.
 *   3. Keep any file whose source-relative path matches an include pattern
 *      OR a `manifestFiles` entry, unless a `!` entry in `manifestFiles`
 *      negates it (npm drops those from the tarball, so the mirror does too).
 *
 * Returns a sorted-by-dest list of {@link CopyPlanEntry} — guaranteeing
 * the second run over the same source produces the same plan.
 */
export async function buildCopyPlan(opts: BuildCopyPlanOptions): Promise<CopyPlanEntry[]> {
  const { packageSourceDir, packageDestDir } = opts;
  const includes = opts.includes ?? DEFAULT_FILE_INCLUDES;
  const excludes = opts.excludes ?? DEFAULT_FILE_EXCLUDES;
  const manifestFiles = opts.manifestFiles ?? [];

  const allFiles = await listFilesRecursive(packageSourceDir);
  const excludeMatchers = excludes.map(globToRegExp);
  const includeMatchers = includes.map(globToRegExp);
  const manifestMatchers = manifestFiles
    .filter(entry => !entry.startsWith('!'))
    .map(entry => globToRegExp(normalizeManifestFileEntry(entry)));
  const negatedMatchers = manifestFiles
    .filter(entry => entry.startsWith('!'))
    .map(entry => globToRegExp(normalizeManifestFileEntry(entry.slice(1))));

  const plan: CopyPlanEntry[] = [];
  for (const file of allFiles) {
    const rel = path.relative(packageSourceDir, file.absolutePath);
    const relPosix = toPosix(rel);

    if (matchesAny(relPosix, excludeMatchers) || matchesAny(relPosix, negatedMatchers)) {
      debug('exclude %s', relPosix);
      continue;
    }

    const included =
      matchesAny(relPosix, includeMatchers) || matchesAny(relPosix, manifestMatchers);
    if (!included) {
      debug('not-included %s', relPosix);
      continue;
    }

    plan.push({
      src: file.absolutePath,
      dest: path.join(packageDestDir, rel),
      size: file.size,
    });
  }

  plan.sort((a, b) => a.dest.localeCompare(b.dest));
  return plan;
}

/**
 * Execute a copy plan. Creates destination directories on demand and
 * copies every entry. Idempotent — re-running over an existing tree
 * overwrites the destination files in place.
 *
 * Errors propagate; the caller decides whether to wipe the partial output.
 */
export async function executeCopyPlan(plan: readonly CopyPlanEntry[]): Promise<void> {
  for (const entry of plan) {
    await mkdir(path.dirname(entry.dest), { recursive: true });
    await copyFile(entry.src, entry.dest);
  }
}

/**
 * Recursively remove a directory if it exists. Used to clean the output
 * tree before each export so regeneration is deterministic.
 *
 * Wraps `fs.rm({ recursive: true, force: true })` — the `force` flag means
 * a missing directory is not an error.
 */
export async function removeDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Recursive directory walker. Returns absolute paths of every file
 * encountered, with size attached so the plan can carry totals.
 *
 * - Symlinks are not followed.
 * - Entries are sorted lexicographically at each level for determinism.
 */
interface DiscoveredFile {
  readonly absolutePath: string;
  readonly size: number;
}

async function listFilesRecursive(root: string): Promise<readonly DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return out;
  }
  if (!rootStat.isDirectory()) return out;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort for determinism — Node's readdir order is filesystem-dependent.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        const st = await stat(full);
        size = st.size;
      } catch {
        // ignore — copy will fail later if the file truly vanishes
      }
      out.push({ absolutePath: full, size });
    }
  }
  await walk(root);
  return out;
}

/**
 * Convert a `package.json#files` entry to a glob the matcher understands.
 *
 * npm's `files` field accepts shorthand like `"dist"` (which means
 * "ship the entire `dist/` directory"). Expand bare directory names to
 * a `dir/**` glob so the matcher includes nested contents.
 */
function normalizeManifestFileEntry(entry: string): string {
  if (entry.length === 0) return entry;
  if (entry.includes('*')) return entry;
  if (entry.endsWith('/')) return `${entry}**`;
  // Leave file-shaped entries alone; bare directory names get a /** suffix.
  // We can't statically tell "file vs directory" without I/O, so we
  // produce both forms: the literal AND the directory form. The matcher
  // accepts either; the file walker will only emit one of them.
  // Encode this as an alternation regex via a unique sentinel.
  return entry;
}

/** Normalise a path to POSIX separators for glob matching. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Test a relative path against a list of regexes. */
function matchesAny(value: string, matchers: readonly RegExp[]): boolean {
  for (const m of matchers) {
    if (m.test(value)) return true;
    // Also handle the "bare dir name" case from manifest files —
    // an entry like "dist" should match any path that starts with `dist/`.
  }
  return false;
}

/**
 * Convert a minimal glob pattern to an anchored regular expression.
 *
 * Supported syntax (deliberately small):
 *   - `**`     matches zero or more path segments (greedy).
 *   - `*`      matches anything except `/`.
 *   - `?`      matches a single character except `/`.
 *   - `.`, `+`, `(`, `)`, `{`, `}`, `[`, `]`, `^`, `$`, `|`, `\` are escaped.
 *   - A trailing bare segment (no glob chars) matches the file itself OR
 *     a directory of that name's contents — so a `files: ["dist"]` entry
 *     matches `dist/index.js`. Achieved by accepting an optional `/...`
 *     tail.
 *
 * Pattern matching is case-sensitive on POSIX paths. Callers pass paths
 * in POSIX form via {@link toPosix}.
 */
function globToRegExp(glob: string): RegExp {
  // Treat a bare segment (no glob, no slash) as "either this exact name
  // OR the contents of a directory with this name."
  if (!glob.includes('*') && !glob.includes('?') && !glob.includes('/')) {
    const escaped = escapeRegex(glob);
    return new RegExp(`^${escaped}(?:/.*)?$`);
  }

  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — match across segments. Account for optional trailing `/`.
        re += '.*';
        i += 2;
        if (glob[i] === '/') i += 1;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    // Escape regex metachars.
    if ('.+()[]{}^$|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** Escape every regex metachar in a literal string. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
