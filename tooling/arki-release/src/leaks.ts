/**
 * Leak scanner — finds private/personal identifiers in files and file
 * paths that would otherwise leak into the public release tree.
 *
 * Two layers:
 *   1. {@link DEFAULT_LEAK_PATTERNS} — the known-blockers list baked from
 *      the workspace's audit history (personal domains, internal app
 *      names, private-monorepo phrasing).
 *   2. {@link NEUTRAL_ALLOW_PATTERNS} — a top-level allow list that drops
 *      hits whose matched substring is a legitimate generic example
 *      (`example.com`, `acme`, `billing`, `support`, …).
 *
 * The scanner is pure (no envelope construction, no exit codes) so it
 * can be embedded by the CLI `audit` command, by Task 5's tree-export
 * pipeline (which scans the GENERATED tree, not the source), and by
 * tests.
 *
 * Stable error code for envelope use: `LEAK_E001`.
 */

import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';

import type { LeakHit, LeakPattern } from './types';

const debug = debugFactory('arki:release:leaks');

/** Stable error code for leak-scan envelope entries. */
export const LEAK_ERROR_CODES = {
  /** A leak pattern matched in a scanned file. */
  patternMatched: 'LEAK_E001',
  /** File-system error while scanning. */
  scanIoError: 'LEAK_E002',
} as const;

/**
 * Default file extensions scanned by {@link scanDirectory}.
 *
 * We intentionally skip binary formats; the leaks we care about are
 * source/docs/config. JSON manifests are included because both pre- and
 * post-materialization manifest leaks must be caught.
 */
export const DEFAULT_SCAN_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
];

/**
 * Default directory names that {@link scanDirectory} never descends into.
 * Match by directory name only — not glob — so excludes are robust to
 * any nesting depth.
 */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  '.turbo',
  '.cache',
  '.next',
  '.git',
  'coverage',
];

/**
 * Hard-coded neutral allow list. A {@link LeakHit} whose `matchedText`
 * matches any of these is dropped from the final result.
 *
 * These are EXAMPLES we explicitly want to permit; they are NOT the same
 * shape as leak patterns (no severity, no id). They run AFTER pattern
 * matching to filter ambiguous hits.
 */
export const NEUTRAL_ALLOW_PATTERNS: readonly RegExp[] = [
  /^example\.com$/i,
  /^my-app$/i,
  /^acme$/i,
  /^billing$/i,
  /^support$/i,
  /^foo$/i,
  /^bar$/i,
  /^baz$/i,
];

/**
 * The default leak-pattern list — baked from the workspace's known
 * blockers as of Task 4. Override via `ReleaseConfig.leakPatterns` when
 * exceptional cases arise.
 *
 * Pattern conventions:
 *   - `\b…\b` word boundaries on app/handle names so we don't fire on
 *     legitimate substrings (e.g. `furcuLITA` inside another word).
 *   - Case-insensitive (`/i`) — leaks frequently land in casual prose.
 *   - Severity defaults to `error`. The single exception is `sudoku`
 *     which may legitimately appear inside a games package — flagged as
 *     `warning` so a human triages it instead of CI auto-blocking.
 */
export const DEFAULT_LEAK_PATTERNS: readonly LeakPattern[] = [
  // ── Personal identifiers ──
  {
    id: 'personal-domain-furculita',
    description: 'Founder personal domain (furculita.net)',
    pattern: /furculita\.net/i,
    severity: 'error',
  },
  {
    id: 'personal-handle-afurculita',
    description: 'Founder personal handle (afurculita)',
    pattern: /\bafurculita\b/i,
    severity: 'error',
  },
  {
    id: 'personal-twitter-handle',
    description: 'Founder Twitter handle (x.com/afurculita)',
    pattern: /x\.com\/afurculita/i,
    severity: 'error',
  },

  // ── Private app names (NEVER ship to npm) ──
  { id: 'app-hyphenate', description: 'Private app: hyphenate', pattern: /\bhyphenate\b/i, severity: 'error' },
  { id: 'app-ekuation', description: 'Private app: ekuation', pattern: /\bekuation\b/i, severity: 'error' },
  { id: 'app-everseek', description: 'Private app: everseek', pattern: /\beverseek\b/i, severity: 'error' },
  { id: 'app-novelette', description: 'Private app: novelette', pattern: /\bnovelette\b/i, severity: 'error' },
  { id: 'app-brandability', description: 'Private app: brandability', pattern: /\bbrandability\b/i, severity: 'error' },
  { id: 'app-toolsforwords', description: 'Private app: toolsforwords', pattern: /\btoolsforwords\b/i, severity: 'error' },
  { id: 'app-sudoku', description: 'App ref: sudoku (verify intentional)', pattern: /\bsudoku\b/i, severity: 'warning' },
  { id: 'app-evervest', description: 'Private app: evervest', pattern: /\bevervest\b/i, severity: 'error' },
  { id: 'app-avocabo', description: 'Private app: avocabo', pattern: /\bavocabo\b/i, severity: 'error' },
  { id: 'app-loonyjobs', description: 'Private app: loony.jobs', pattern: /\bloony\.?jobs\b/i, severity: 'error' },
  { id: 'app-domodoro', description: 'Private app: domodoro', pattern: /\bdomodoro\b/i, severity: 'error' },
  { id: 'app-listio', description: 'Private app: listio', pattern: /\blistio\b/i, severity: 'error' },
  { id: 'app-manuscribed', description: 'Private app: manuscribed', pattern: /\bmanuscribed\b/i, severity: 'error' },
  { id: 'app-typeroom', description: 'Private app: typeroom', pattern: /\btyperoom\b/i, severity: 'error' },
  { id: 'app-structurize', description: 'Private app: structurize', pattern: /\bstructurize\b/i, severity: 'error' },
  { id: 'app-diffdigg', description: 'Private app: diffdigg', pattern: /\bdiffdigg\b/i, severity: 'error' },
  { id: 'app-ucssr', description: 'Private app: ucssr', pattern: /\bucssr\b/i, severity: 'error' },

  // ── Private-monorepo / internal language ──
  {
    id: 'private-monorepo-phrase',
    description: 'Internal monorepo phrasing ("private monorepo")',
    pattern: /private monorepo/i,
    severity: 'error',
  },
  {
    id: 'internal-only-phrase',
    description: 'Internal-only phrasing',
    pattern: /internal[- ]?only/i,
    severity: 'warning',
  },
];

/** Options accepted by {@link scanDirectory}. */
export interface ScanDirectoryOptions {
  readonly patterns: readonly LeakPattern[];
  /** File extensions to scan. Defaults to {@link DEFAULT_SCAN_EXTENSIONS}. */
  readonly extensions?: readonly string[];
  /** Directory names to skip. Defaults to {@link DEFAULT_EXCLUDE_DIRS}. */
  readonly excludeDirs?: readonly string[];
  /** When true, paths in hits are relative to this root. Defaults to true. */
  readonly relative?: boolean;
  /**
   * Skip files larger than this many bytes (default: 1MB). Vendored
   * dictionaries and bundled data files don't realistically contain
   * personal leaks and ballooning the scanner over them turns a tight
   * audit into a 60-second wait.
   */
  readonly maxFileBytes?: number;
  /**
   * When true (default), nested workspace sub-packages (directories that
   * themselves contain a `package.json`) are NOT descended into. This is
   * critical for monorepo packages whose source tree contains sibling
   * sub-packages — without this, scanning `packages/text` would also
   * walk every nested sub-package and its vendored data.
   */
  readonly skipNestedWorkspaces?: boolean;
}

/** Default maximum scanned file size (1MB). */
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/**
 * Trim a context window around a match for snippet display.
 *
 * Goal: ~80 chars centered on the match, but never spanning beyond the
 * current line (line breaks are removed first).
 */
function buildSnippet(line: string, matchIndex: number, matchLength: number): string {
  const oneLine = line.replace(/\r?\n/g, ' ');
  const window = 80;
  const half = Math.floor((window - matchLength) / 2);
  const start = Math.max(0, matchIndex - Math.max(0, half));
  const end = Math.min(oneLine.length, matchIndex + matchLength + Math.max(0, half));
  let snippet = oneLine.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < oneLine.length) snippet = `${snippet}…`;
  return snippet;
}

/**
 * Check whether a matched substring is in the neutral allow list.
 * Returns true when the hit should be filtered out.
 */
function isAllowed(matchedText: string, perPatternAllowList?: readonly RegExp[]): boolean {
  for (const pat of NEUTRAL_ALLOW_PATTERNS) {
    if (pat.test(matchedText)) return true;
  }
  if (perPatternAllowList) {
    for (const pat of perPatternAllowList) {
      if (pat.test(matchedText)) return true;
    }
  }
  return false;
}

/**
 * Scan a single in-memory text blob for leak hits.
 *
 * Pure — does no I/O. Used by both {@link scanFile} and tests that
 * exercise the matcher without filesystem fixtures.
 *
 * Each pattern is matched globally via `String.prototype.matchAll`. We
 * ignore the source pattern's `g` flag and add it ourselves so callers
 * don't have to worry about it.
 */
export function scanText(
  content: string,
  sourcePath: string,
  patterns: readonly LeakPattern[],
): readonly LeakHit[] {
  const hits: LeakHit[] = [];
  const lines = content.split(/\r?\n/);

  for (const pattern of patterns) {
    // Recreate the regex with `g` so matchAll works (`g` is required).
    const flags = `${pattern.pattern.flags.replace(/g/g, '')}g`;
    const re = new RegExp(pattern.pattern.source, flags);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? '';
      for (const match of line.matchAll(re)) {
        const matchedText = match[0];
        const matchIndex = match.index ?? 0;
        if (isAllowed(matchedText, pattern.allowList)) continue;
        hits.push({
          patternId: pattern.id,
          severity: pattern.severity,
          description: pattern.description,
          sourcePath,
          line: lineIdx + 1,
          column: matchIndex + 1,
          matchedText,
          snippet: buildSnippet(line, matchIndex, matchedText.length),
        });
      }
    }
  }

  return hits;
}

/**
 * Scan a single file on disk.
 *
 * - Returns hits with `sourcePath` set to the provided path (caller
 *   controls absolute vs relative).
 * - Reads UTF-8. Files that fail to read are reported via debug log and
 *   produce zero hits (the caller is responsible for surfacing I/O
 *   errors in the envelope if needed).
 */
export async function scanFile(
  absolutePath: string,
  patterns: readonly LeakPattern[],
  options?: { readonly displayPath?: string },
): Promise<readonly LeakHit[]> {
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (cause) {
    debug('scanFile read error: %s — %s', absolutePath, cause instanceof Error ? cause.message : String(cause));
    return [];
  }
  const sourcePath = options?.displayPath ?? absolutePath;
  return scanText(content, sourcePath, patterns);
}

/**
 * Walk a directory recursively and scan every matching file.
 *
 * - Symlinks are not followed (we use `readdir(withFileTypes)` and only
 *   recurse into `entry.isDirectory()`; symlinks land in neither branch).
 * - The root path itself is also scanned for leaks in its NAME — file
 *   paths can leak too (e.g. a file literally named `furculita.txt`).
 */
export async function scanDirectory(
  rootPath: string,
  options: ScanDirectoryOptions,
): Promise<readonly LeakHit[]> {
  const extensions = options.extensions ?? DEFAULT_SCAN_EXTENSIONS;
  const excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
  const relative = options.relative !== false;
  const patterns = options.patterns;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const skipNestedWorkspaces = options.skipNestedWorkspaces !== false;

  async function isWorkspaceRoot(dir: string): Promise<boolean> {
    try {
      await access(path.join(dir, 'package.json'));
      return true;
    } catch {
      return false;
    }
  }

  // Verify the root is a directory before recursing.
  let rootStat;
  try {
    rootStat = await stat(rootPath);
  } catch (cause) {
    debug('scanDirectory stat error: %s — %s', rootPath, cause instanceof Error ? cause.message : String(cause));
    return [];
  }
  if (!rootStat.isDirectory()) {
    // Allow callers to pass a file path — degrade gracefully.
    const displayPath = relative ? path.basename(rootPath) : rootPath;
    return scanFile(rootPath, patterns, { displayPath });
  }

  const allHits: LeakHit[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (cause) {
      debug('scanDirectory readdir error: %s — %s', current, cause instanceof Error ? cause.message : String(cause));
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (skipNestedWorkspaces && full !== rootPath && (await isWorkspaceRoot(full))) {
          debug('scanDirectory skip nested workspace: %s', full);
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.includes(ext)) continue;

      const displayPath = relative ? path.relative(rootPath, full) : full;

      // Scan the path itself first — catches things like a file literally
      // named `furculita.md`. This is cheap and runs before the size cap
      // because the path is one short string.
      const pathHits = scanText(displayPath, displayPath, patterns).map(h => ({
        ...h,
        line: 0,
        column: 0,
      }));
      allHits.push(...pathHits);

      // Skip oversized files — vendored data (dictionaries, embeddings,
      // bibles) doesn't contain founder leaks and pathological matches
      // against giant JSON blobs can turn a 100ms audit into a 60-second
      // wall-clock hang.
      let fileSize = 0;
      try {
        const st = await stat(full);
        fileSize = st.size;
      } catch {
        // Ignore stat errors; readFile below will handle the fallout.
      }
      if (fileSize > maxFileBytes) {
        debug('scanDirectory skip oversized file: %s (%d bytes)', displayPath, fileSize);
        continue;
      }

      const fileHits = await scanFile(full, patterns, { displayPath });
      allHits.push(...fileHits);
    }
  }

  await walk(rootPath);
  return allHits;
}
