#!/usr/bin/env bun
/**
 * `arki-llms`: writes the `## Import paths` section of a package's `llms.txt`
 * from `package.json` `exports`, so `DOC_E006` cannot drift.
 *
 * Each export key (not `./package.json`, not wildcards) becomes one bullet:
 * the specifier, the first line of the entry module's top comment, and the
 * names it exports (values first, then `types ...`, each sorted). When those
 * bullets would push the file over the `DOC_E007` budget, the keys are grouped
 * by their first path segment instead (see `groupedLines`). The section lives between
 * `<!-- llms:start -->` and `<!-- llms:end -->`; everything outside the markers
 * stays as written. A section with no markers is replaced whole and gets them.
 *
 *   arki-llms            print the generated bullets
 *   arki-llms --write    update llms.txt
 *   arki-llms --check    exit 1 with a diff when llms.txt is stale
 *
 * The entry module is the source behind the export (`dist/x.js` reads
 * `src/x.ts`), so the result does not depend on a build.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';

import type { Manifest } from './manifest';
import { LLMS_MAX_BYTES, LLMS_MAX_LINES, LLMS_SECTIONS } from './docs';
import { headings, splitLines } from './markdown';
import { leaves, readManifest, runtimeEntry } from './manifest';
import { complain, say } from './report';

export const LLMS_START = '<!-- llms:start -->';
export const LLMS_END = '<!-- llms:end -->';
const SECTION = LLMS_SECTIONS[0];
/** Names listed per bullet. More would crowd the 80-line file; the rest are one `exports` lookup away. */
const MAX_NAMES = 12;

/** Raised for a problem the author must fix; the CLI prints the message and exits 2. */
export class LlmsError extends Error {}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts'];
const isFile = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile();

/** The source file behind an export value: the value itself if source, else `dist/` read as `src/`. */
function sourceFor(dir: string, value: string): string | undefined {
  const absolute = path.resolve(dir, value);
  if (/\.(?:[cm]?ts|tsx)$/.test(value) && !/\.d\.[cm]?ts$/.test(value) && isFile(absolute)) return absolute;
  const stem = path
    .relative(dir, absolute)
    .replace(/^dist(?=[\\/])/, 'src')
    .replace(/(?:\.d)?\.[cm]?[jt]sx?$/, '');
  for (const extension of SOURCE_EXTENSIONS) {
    for (const candidate of [path.join(dir, stem + extension), path.join(dir, stem, `index${extension}`)]) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The module file for an export key, or `undefined` for a non-code target (css, json). */
function entryFile(dir: string, subpath: string, manifest: Manifest): string | undefined {
  const target = manifest.exports[subpath] ?? null;
  const values = [
    ...leaves(target)
      .filter(leaf => leaf.conditions.includes('types'))
      .map(leaf => leaf.value),
    runtimeEntry(target),
  ].filter((value): value is string => value !== undefined);
  if (values.length === 0) return undefined;
  for (const value of values) {
    const found = sourceFor(dir, value);
    if (found !== undefined) return found;
  }
  for (const value of values) {
    const built = path.resolve(dir, value);
    if (/\.d\.[cm]?ts$/.test(value) && isFile(built)) return built;
  }
  throw new LlmsError(`export "${subpath}": no source or built types for ${values.join(', ')}`);
}

/**
 * The first sentence of the comment that opens the file, as one line: a leading
 * `@arki/x -` title and `@tags` dropped. Empty when the file has no such comment.
 */
function moduleSummary(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
  const comment = ts.getLeadingCommentRanges(text, 0)?.find(range => text.startsWith('/**', range.pos));
  if (comment === undefined) return '';
  const lines = text
    .slice(comment.pos, comment.end)
    .replace(/^\/\*\*+|\*+\/$/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\*? ?/, '').trim());
  const end = lines.findIndex((line, index) => line === '' && lines.slice(0, index).some(Boolean));
  const paragraph = lines
    .slice(0, end === -1 ? undefined : end)
    .filter(line => line !== '' && !/^@(?!arki\/)/.test(line))
    .join(' ')
    .replace(/^`?@arki\/[\w/-]+`?\s*[-\u2014:]\s+/, '');
  const sentence = /^.*?\.(?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
  return sentence.replace(/\.$/, '').trim();
}

type ExportedNames = { readonly values: readonly string[]; readonly types: readonly string[] };

/**
 * Exported names per entry file, as the compiler sees them (re-exports and `export *` followed), sorted, so
 * the list does not depend on the compiler's symbol table order.
 */
function exportedNames(files: readonly string[]): ReadonlyMap<string, ExportedNames> {
  const program = ts.createProgram([...files], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const names = new Map<string, ExportedNames>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    const values: string[] = [];
    const types: string[] = [];
    for (const symbol of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
      const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      (resolved.flags & ts.SymbolFlags.Value ? values : types).push(symbol.name);
    }
    names.set(file, { values: values.toSorted(), types: types.toSorted() });
  }
  return names;
}

const code = (names: readonly string[], prefix = ''): string =>
  names.length === 0 ? '' : `${prefix}${names.map(name => `\`${name}\``).join(', ')}`;

function nameList(names: ExportedNames): string {
  const total = names.values.length + names.types.length;
  const values = names.values.slice(0, MAX_NAMES);
  const types = names.types.slice(0, MAX_NAMES - values.length);
  const more = total - values.length - types.length;
  return [code(values), code(types, 'types '), more > 0 ? `and ${String(more)} more` : '']
    .filter(part => part !== '')
    .join('; ');
}

/**
 * Backticked package specifiers in a description would count as named import paths
 * in `DOC_E006`, so they are written plain.
 */
function plain(description: string, packageName: string): string {
  return description.replaceAll(/`([^`]+)`/g, (whole, inner: string) =>
    inner === packageName || inner.startsWith(`${packageName}/`) ? inner : whole,
  );
}

interface ImportPath {
  subpath: string;
  specifier: string;
  description: string;
  bullet: string;
}

function importPaths(dir: string, manifest: Manifest): ImportPath[] {
  const subpaths = Object.keys(manifest.exports).filter(key => key !== './package.json' && !key.includes('*'));
  const entries = subpaths.map(subpath => ({ subpath, file: entryFile(dir, subpath, manifest) }));
  const files = [...new Set(entries.flatMap(entry => (entry.file === undefined ? [] : [entry.file])))];
  const names = exportedNames(files);
  return entries.map(({ subpath, file }) => {
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    const description = file === undefined ? '' : plain(moduleSummary(file), manifest.name);
    const list = file === undefined ? '' : nameList(names.get(file) ?? { values: [], types: [] });
    const tail = [description === '' ? '' : `${description}.`, list === '' ? '' : `${list}.`].filter(part => part !== '').join(' ');
    return { subpath, specifier, description, bullet: `- \`${specifier}\`${tail === '' ? '' : `: ${tail}`}` };
  });
}

/** The bullets of the Import paths section, one per export key, in `exports` order. */
export function importPathLines(dir: string, manifest: Manifest): string[] {
  return importPaths(dir, manifest).map(entry => entry.bullet);
}

/** `./core/tables` → `core`; the root key `.` is its own group. */
const firstSegment = (subpath: string): string => (subpath === '.' ? '.' : (subpath.slice(2).split('/')[0] ?? ''));

/**
 * The compact Import paths section for packages with too many exports for one
 * bullet each. The root entry keeps its full bullet. Keys that share a first
 * path segment become one bullet that names every specifier, led by the
 * summary of `./<segment>` when that key exists. Keys alone in their segment
 * are collected into one last bullet, because a flat package (one subpath per
 * component) would otherwise still need a line per export. Every specifier is
 * still named, so `DOC_E006` holds.
 */
function groupedLines(paths: readonly ImportPath[]): string[] {
  const groups = new Map<string, ImportPath[]>();
  for (const entry of paths) {
    const segment = firstSegment(entry.subpath);
    groups.set(segment, [...(groups.get(segment) ?? []), entry]);
  }
  const lines: string[] = [];
  const alone: ImportPath[] = [];
  for (const [segment, members] of groups) {
    const [only] = members;
    if (segment === '.') lines.push(...members.map(entry => entry.bullet));
    else if (members.length === 1 && only !== undefined) alone.push(only);
    else {
      const head = members.find(entry => entry.subpath === `./${segment}`);
      const summary = head === undefined || head.description === '' ? '' : ` ${head.description}.`;
      const specifiers = code(members.map(entry => entry.specifier));
      lines.push(`- ${segment}/* (${String(members.length)} paths):${summary} ${specifiers}.`);
    }
  }
  if (alone.length > 0) lines.push(`- one path each: ${code(alone.map(entry => entry.specifier))}.`);
  return lines;
}

/**
 * `text` with the Import paths bullets replaced: between the markers when they
 * exist, else the whole section body (the markers are added). Throws when the
 * file has no `## Import paths` and no markers.
 */
export function applyImportPaths(text: string, bullets: readonly string[]): string {
  const lines = splitLines(text);
  const block = [LLMS_START, ...bullets, LLMS_END];
  const start = lines.indexOf(LLMS_START);
  const end = lines.indexOf(LLMS_END);
  let next: string[];
  if (start !== -1 && end > start) {
    next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
  } else if (start !== -1 || end !== -1) {
    throw new LlmsError(`llms.txt has only one of ${LLMS_START} and ${LLMS_END}, or them out of order`);
  } else {
    const h2s = headings(text).filter(heading => heading.level === 2);
    const index = h2s.findIndex(heading => heading.text === SECTION);
    const heading = h2s[index];
    if (heading === undefined) throw new LlmsError(`llms.txt has no "## ${SECTION}" section to fill`);
    const after = h2s[index + 1]?.line;
    const tail = after === undefined ? [''] : ['', ...lines.slice(after - 1)];
    next = [...lines.slice(0, heading.line), '', ...block, ...tail];
  }
  return next.join('\n');
}

/** Why `text` breaks the `DOC_E007` budget, or `undefined` when it fits. */
function overBudget(text: string): string | undefined {
  const lines = text.endsWith('\n') ? splitLines(text).length - 1 : splitLines(text).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (lines <= LLMS_MAX_LINES && bytes <= LLMS_MAX_BYTES) return undefined;
  const parts = [
    ...(lines > LLMS_MAX_LINES ? [`${String(lines - LLMS_MAX_LINES)} line(s) over ${String(LLMS_MAX_LINES)}`] : []),
    ...(bytes > LLMS_MAX_BYTES ? [`${String(bytes - LLMS_MAX_BYTES)} byte(s) over ${String(LLMS_MAX_BYTES)}`] : []),
  ];
  return `generated llms.txt is ${String(lines)} lines, ${String(bytes)} bytes (${parts.join(', ')})`;
}

/**
 * The full `llms.txt` this package should have: one bullet per export when that
 * fits the budget, else the grouped section. Throws `LlmsError` when even the
 * grouped file is over budget, since the hand-written sections must shrink.
 */
export function generateLlms(dir: string, manifest: Manifest, current: string): string {
  const paths = importPaths(dir, manifest);
  const flat = applyImportPaths(current, paths.map(entry => entry.bullet));
  if (overBudget(flat) === undefined) return flat;
  const grouped = applyImportPaths(current, groupedLines(paths));
  const problem = overBudget(grouped);
  if (problem !== undefined) throw new LlmsError(`${problem} even with exports grouped; shorten the hand-written sections`);
  return grouped;
}

/** Removed lines with `-`, added lines with `+`; context is left out. */
export function lineDiff(before: string, after: string): string[] {
  const old = splitLines(before);
  const fresh = splitLines(after);
  const kept = new Set(fresh);
  const present = new Set(old);
  return [
    ...old.filter(line => !kept.has(line)).map(line => `- ${line}`),
    ...fresh.filter(line => !present.has(line)).map(line => `+ ${line}`),
  ];
}

function main(): number {
  const { values } = parseArgs({
    options: { write: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } },
  });
  if (values.write && values.check) {
    complain('arki-llms: pass --write or --check, not both');
    return 2;
  }
  const dir = process.cwd();
  const file = path.join(dir, 'llms.txt');
  try {
    const manifest = readManifest(dir);
    if (!existsSync(file)) {
      if (values.check) complain('arki-llms: no llms.txt');
      else complain('arki-llms: no llms.txt (DOC_E002); create it from the template first');
      return values.check ? 1 : 2;
    }
    const current = readFileSync(file, 'utf8');
    const next = generateLlms(dir, manifest, current);
    if (values.check) {
      if (next === current) return 0;
      complain(`arki-llms: ${manifest.name} llms.txt is stale; run arki-llms --write`);
      for (const line of lineDiff(current, next)) complain(line);
      return 1;
    }
    if (values.write) {
      if (next !== current) writeFileSync(file, next);
      say(`arki-llms: ${manifest.name} ${next === current ? 'up to date' : 'written'}`);
      return 0;
    }
    for (const line of importPathLines(dir, manifest)) say(line);
    return 0;
  } catch (error) {
    if (error instanceof LlmsError) {
      complain(`arki-llms: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(main());
