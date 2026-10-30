/**
 * `@arki/journal/event-map`: the Node-only half of `dot explain --as event-map`. It reads the app's
 * procedure files, finds the journal commands they import, and adds them to the graph. Dot loads this
 * module from the manifest (`project` and `render`), so `dot explain --as event-map` finds the commands without a
 * declaration: a procedure imports a command and calls `context.run(command, input)` (no list names it).
 *
 * How the scan works:
 * 1. It walks the scan root (`src/features` by default, or the `entrypointRoot` of `journal({ j })`) and takes
 *    every file under an `entrypoints` folder, except tests and `.d.ts` files. The folder above `entrypoints` names the feature.
 * 2. It reads each file's static imports with a pattern match: relative specifiers only, `import type` skipped. A
 *    named import keeps those names, a namespace import keeps every export, a default import keeps `default`.
 * 3. It imports each module the file names, and keeps the exports that fit `journalCommandSchema`.
 *
 * A command that is imported and never called still gets its edge: the scan reads imports, not calls. A path alias
 * or a package specifier is not followed. A module that fails to import, or an import that does not resolve, is
 * reported in `problems` and the rest of the map is still drawn.
 *
 * Needs `node:fs`, so it is its own subpath and never part of the portable entries.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { is } from '@arki/schema';

import type { EventMapDocument, EventMapProblem, EventMapScanEntry } from './projection.js';

import { journalCommandSchema } from './event-map-schema.js';
import { projectGraph, withEntrypoints } from './projection.js';

export { eventMapPage as consolePage } from './event-map-page.js';
export { render } from './projection.js';

const PROCEDURE_FILE = /\.(?:ts|tsx|mts|js|mjs)$/;
const NOT_PROCEDURE = /\.(?:test|spec)\.|\.d\.ts$/;
/** `import`, then everything up to the first quote (the clause and `from`), then the quoted specifier. */
const IMPORT_STATEMENT = /^[ \t]*import\b([^'";]*)['"]([^'"]+)['"]/gm;

/** Every file under `entrypoints` folders below `root`, sorted, as paths relative to `root`. */
async function procedureFiles(root: string, problems: EventMapProblem[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      problems.push({ file: path.relative(root, directory) || '.', reason: `cannot read the folder: ${messageOf(error)}` });
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) await walk(full);
      } else if (PROCEDURE_FILE.test(entry.name) && !NOT_PROCEDURE.test(entry.name)) {
        const relative = path.relative(root, full).split(path.sep);
        if (relative.slice(0, -1).includes('entrypoints')) found.push(relative.join('/'));
      }
    }
  };
  await walk(root);
  return found.toSorted();
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What one import statement names: the specifier, and the export names it keeps (`'*'`: every export). */
type Import = { readonly specifier: string; readonly names: readonly string[] };

function importsOf(source: string): Import[] {
  const imports: Import[] = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    const [, head = '', specifier] = match;
    if (specifier === undefined || !specifier.startsWith('.') || /^\s*type\s+(?!from\b)/.test(head)) continue;
    const trimmed = head.trimEnd();
    const clause = trimmed.endsWith('from') ? trimmed.slice(0, -4) : '';
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    for (const part of (braces?.[1] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0] ?? '';
      if (name !== '' && !name.startsWith('type ')) names.push(name);
    }
    const outside = clause.replace(/\{[^}]*\}/, '');
    if (/\*\s*as\s/.test(outside)) names.push('*');
    else if (outside.replaceAll(',', '').trim() !== '') names.push('default');
    imports.push({ specifier, names });
  }
  return imports;
}

/** A relative specifier as a file on disk: as written, `.js` for `.ts`, an added extension, or an `index` file. */
async function resolveFile(from: string, specifier: string): Promise<string | undefined> {
  const base = path.resolve(path.dirname(from), specifier);
  const stem = base.replace(/\.(?:js|mjs)$/, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  for (const candidate of candidates) {
    const isFile = await stat(candidate).then(
      info => info.isFile(),
      () => false,
    );
    if (isFile) return candidate;
  }
  return undefined;
}

type FoundCommand = { readonly exportName: string; readonly name: string; readonly writes: readonly string[] };

/** The journal commands a module exports. A module that does not import is a problem, not a throw. */
async function commandsOf(file: string): Promise<readonly FoundCommand[] | string> {
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    return `cannot import: ${messageOf(error)}`;
  }
  const commands: FoundCommand[] = [];
  for (const [exportName, value] of Object.entries(loaded)) {
    if (is(value, journalCommandSchema))
      commands.push({ exportName, name: value.name, writes: value.writes.map(event => event.type) });
  }
  return commands;
}

/** What the scan found: one entry per procedure file, and the files or imports it could not read. */
export type EventMapScan = {
  readonly entries: EventMapScanEntry[];
  readonly problems: EventMapProblem[];
};

/**
 * Scan the procedure files under `root` (an absolute folder). Files are found by the `entrypoints` folder
 * convention; the result is sorted by file, so the same app gives the same scan on every machine.
 */
export async function scanEntrypoints(options: { readonly root: string }): Promise<EventMapScan> {
  const problems: EventMapProblem[] = [];
  const files = await procedureFiles(options.root, problems);
  const modules = new Map<string, Promise<readonly FoundCommand[] | string>>();
  const entries: EventMapScanEntry[] = [];
  for (const file of files) {
    const absolute = path.join(options.root, file);
    const segments = file.split('/');
    const feature = segments[segments.indexOf('entrypoints') - 1] ?? path.basename(options.root);
    const commands = new Map<string, { name: string; writes: readonly string[] }>();
    for (const statement of importsOf(await readFile(absolute, 'utf8'))) {
      const target = await resolveFile(absolute, statement.specifier);
      if (target === undefined) {
        problems.push({ file, reason: `import "${statement.specifier}" does not resolve to a file` });
        continue;
      }
      const pending = modules.get(target) ?? commandsOf(target);
      modules.set(target, pending);
      const found = await pending;
      if (typeof found === 'string') {
        problems.push({ file, reason: `import "${statement.specifier}": ${found}` });
        continue;
      }
      for (const command of found) {
        if (statement.names.includes('*') || statement.names.includes(command.exportName))
          commands.set(command.name, { name: command.name, writes: command.writes });
      }
    }
    entries.push({ feature, file, commands: [...commands.values()] });
  }
  return { entries, problems };
}

type ManifestLike = Parameters<typeof projectGraph>[0];

/**
 * The module Dot loads for `dot explain --as event-map`: the manifest's graph plus the scan of the
 * entrypoint root, which is resolved against `cwd` (the folder `dot` runs in, by default).
 */
export async function project(manifest: ManifestLike, cwd: string = process.cwd()): Promise<EventMapDocument> {
  const { document, entrypointRoot } = projectGraph(manifest);
  if (entrypointRoot === undefined) return document;
  const scan = await scanEntrypoints({ root: path.resolve(cwd, entrypointRoot) });
  return withEntrypoints(document, scan.entries, scan.problems);
}

/** The result of `checkEventMapFile`. A `stale` or `missing` file carries a line diff for the test report. */
export type EventMapFileCheck =
  | { readonly state: 'fresh' }
  | { readonly state: 'written' }
  | { readonly state: 'stale' | 'missing'; readonly diff: string };

/** A line diff of the changed lines: `-` for lines only in the file on disk, `+` for lines only in the new text. Small files only. */
function lineDiff(before: readonly string[], after: readonly string[]): string {
  const width = after.length + 1;
  // `common[i * width + j]`: the length of the longest common run of `before[i..]` and `after[j..]`.
  const common = Array.from({ length: (before.length + 1) * width }, () => 0);
  const at = (i: number, j: number): number => common[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1)
    for (let j = after.length - 1; j >= 0; j -= 1)
      common[i * width + j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i += 1;
      j += 1;
    } else if (i < before.length && (j === after.length || at(i + 1, j) >= at(i, j + 1))) {
      out.push(`- ${before[i]}`);
      i += 1;
    } else {
      out.push(`+ ${after[j]}`);
      j += 1;
    }
  }
  return out.join('\n');
}

/**
 * Keep a Mermaid file in an app's docs fresh. In a test, call it with the file and `eventMapMermaid(document)`
 * and expect `{ state: 'fresh' }`; a stale file fails the test and the report shows the diff. To regenerate,
 * run the test with `update: true` (apps wire it to an env var, e.g. `EVENT_MAP_UPDATE=1 bun run test`); the file is written
 * and `{ state: 'written' }` comes back, which also fails an expectation of `fresh`, so an update never passes quietly in CI.
 */
export async function checkEventMapFile(options: {
  readonly file: string;
  readonly mermaid: string;
  readonly update?: boolean;
}): Promise<EventMapFileCheck> {
  const current = await readFile(options.file, 'utf8').then(
    text => text,
    () => null,
  );
  if (current === options.mermaid) return { state: 'fresh' };
  if (options.update === true) {
    await mkdir(path.dirname(options.file), { recursive: true });
    await writeFile(options.file, options.mermaid);
    return { state: 'written' };
  }
  if (current === null) return { state: 'missing', diff: lineDiff([], options.mermaid.split('\n')) };
  return { state: 'stale', diff: lineDiff(current.split('\n'), options.mermaid.split('\n')) };
}
