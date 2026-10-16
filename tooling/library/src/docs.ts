/**
 * The agent-docs rules of `arki-library-check` (lesson 13). Every public
 * package (`"private"` is not `true`) ships three files in a fixed shape:
 *
 *   README.md             the long overview, for humans
 *   llms.txt              the index an agent reads first (spec: tooling/library/README.md)
 *   docs/agent-guide.md   the model, the task map, the rules, the errors, how to verify
 *
 * Each problem is one message, `${rule} ${text}${detail}`, so a known one can
 * sit in `library-check-baseline.json` as an exact string. Rules E004-E012 on a
 * file fire only when that file exists, so a missing file is one baseline line.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CheckResult } from './library-check';
import type { Manifest } from './manifest';
import { h2Sections, headings, scanFences, splitLines } from './markdown';

export const DOC_RULES = {
  DOC_E001: 'no README.md',
  DOC_E002: 'no llms.txt',
  DOC_E003: 'no docs/agent-guide.md',
  DOC_E004: 'llms.txt must start with "# @arki/<name>" then one "> " summary line',
  DOC_E005: 'llms.txt missing or misordered section',
  DOC_E006: 'llms.txt "Import paths" differs from exports',
  DOC_E007: 'llms.txt over budget (80 lines or 8 KiB)',
  DOC_E008: 'broken local link or anchor',
  DOC_E009: 'link leaves the package',
  DOC_E010: 'agent guide missing or misordered section',
  DOC_E011: 'agent guide "Verify" lacks dot explain --json and dot doctor --json',
  DOC_E012: 'package.json "files" does not ship a doc file',
  DOC_E013: 'no "test:docs" script',
  DOC_W001: 'forward-looking language',
  DOC_W002: 'llms.txt over 60 lines',
} as const;
export type DocRule = keyof typeof DOC_RULES;

/** The H2s of `llms.txt`, in order. `## Optional` may follow them; nothing else may. */
export const LLMS_SECTIONS = ['Import paths', 'Start here', 'By task', 'Rules that bite'] as const;
/** The H2s of the agent guide, in order. Other H2s may sit between them. */
export const GUIDE_SECTIONS = ['The model', 'Task map', 'Rules that bite', 'Errors', 'Verify'] as const;

const LLMS = 'llms.txt';
const GUIDE = 'docs/agent-guide.md';
const OPTIONAL = 'Optional';
const LLMS_MAX_LINES = 80;
const LLMS_WARN_LINES = 60;
const LLMS_MAX_BYTES = 8192;
/** A heuristic for promises the code does not keep yet; a warning only. */
const FORWARD_LOOKING = /\b(?:future|will land|v1\.1|coming soon|deferred|not yet)\b/gi;

function message(rule: DocRule, detail = ''): string {
  return `${rule} ${DOC_RULES[rule]}${detail}`;
}

export type LlmsTxt = {
  /** The H1 text (`@arki/journal`); empty when line 1 is not an H1. */
  readonly name: string;
  /** The first `> ` line after the H1, without the marker; empty when there is none. */
  readonly summary: string;
  /** H2 text to the raw lines under it. */
  readonly sections: ReadonlyMap<string, readonly string[]>;
};

export function parseLlmsTxt(text: string): LlmsTxt {
  const lines = splitLines(text);
  const name = /^# (.+)$/.exec(lines[0] ?? '')?.[1]?.trim() ?? '';
  const first = lines.slice(1).find(line => line.trim() !== '') ?? '';
  return { name, summary: first.startsWith('> ') ? first.slice(2).trim() : '', sections: h2Sections(text) };
}

/** GitHub's heading slug: the rendered text, lower-cased, punctuation dropped, each space a dash. */
function slug(heading: string): string {
  return heading
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}

/** Every anchor a link may target in this file: heading slugs (`-1`, `-2` on repeats) and HTML `id`/`name`. */
export function headingAnchors(markdown: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const heading of headings(markdown)) {
    const base = slug(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  for (const { text } of scanFences(markdown).prose) {
    for (const match of text.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) {
      if (match[1] !== undefined) anchors.add(match[1]);
    }
  }
  return anchors;
}

const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(\S+)/;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Every link target outside code (fences and inline code spans), with its line. */
function allLinks(markdown: string): { href: string; line: number }[] {
  return scanFences(markdown).prose.flatMap(({ text, line }) => {
    const prose = text.replaceAll(/(`+)[^`]*\1/g, '');
    const hrefs = [...prose.matchAll(INLINE_LINK)].map(match => match[1] ?? '');
    const reference = REFERENCE_DEFINITION.exec(prose)?.[1];
    if (reference !== undefined) hrefs.push(reference);
    return hrefs.filter(href => href !== '').map(href => ({ href: href.replaceAll(/^<|>$/g, ''), line }));
  });
}

/** Links with no URL scheme: files and `#anchors` in this package. */
export function localLinks(markdown: string): readonly { href: string; line: number }[] {
  return allLinks(markdown).filter(link => !SCHEME.test(link.href));
}

/** `%20` and friends decoded; a malformed escape stays as written (and then resolves to nothing). */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Checks one doc file's links. Returns the problems and the package files it links to. */
function checkLinks(dir: string, file: string, markdown: string): { errors: string[]; targets: string[] } {
  const errors: string[] = [];
  const targets: string[] = [];
  for (const { href } of allLinks(markdown)) {
    if (SCHEME.test(href)) {
      // External links are checked for syntax only, never fetched.
      if (/^https?:/i.test(href) && !URL.canParse(href)) errors.push(message('DOC_E008', `: ${file} links ${href}`));
      continue;
    }
    const hash = href.indexOf('#');
    const target = hash === -1 ? href : href.slice(0, hash);
    const anchor = hash === -1 ? '' : decoded(href.slice(hash + 1)).toLowerCase();
    if (target.startsWith('/')) {
      errors.push(message('DOC_E009', `: ${file} links ${href}`));
      continue;
    }
    const absolute = target === '' ? path.join(dir, file) : path.resolve(path.dirname(path.join(dir, file)), target);
    const relative = path.relative(dir, decoded(absolute));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(message('DOC_E009', `: ${file} links ${href}`));
      continue;
    }
    if (!existsSync(path.join(dir, relative))) {
      errors.push(message('DOC_E008', `: ${file} links ${href}`));
      continue;
    }
    if (target !== '' && statSync(path.join(dir, relative)).isFile()) targets.push(relative.split(path.sep).join('/'));
    if (anchor !== '' && relative.endsWith('.md')) {
      const body = target === '' ? markdown : readFileSync(path.join(dir, relative), 'utf8');
      if (!headingAnchors(body).has(anchor)) errors.push(message('DOC_E008', `: ${file} links ${href}`));
    }
  }
  return { errors, targets };
}

function forwardLooking(file: string, markdown: string): string[] {
  const hits = scanFences(markdown).prose.flatMap(({ text, line }) =>
    [...text.matchAll(FORWARD_LOOKING)].map(match => `${String(line)} "${match[0]}"`),
  );
  return hits.length === 0 ? [] : [message('DOC_W001', `: ${file} line ${hits.join(', line ')}`)];
}

/** `@arki/<name>` and `@arki/<name>/<sub>` written in backticks, as `exports` keys (`.`, `./sub`). */
function namedSubpaths(lines: readonly string[], name: string): Set<string> {
  const subpaths = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const spec = match[1] ?? '';
      if (spec === name) subpaths.add('.');
      else if (spec.startsWith(`${name}/`)) subpaths.add(`./${spec.slice(name.length + 1)}`);
    }
  }
  return subpaths;
}

function checkLlms(dir: string, manifest: Manifest, text: string): CheckResult & { targets: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const llms = parseLlmsTxt(text);
  const lines = splitLines(text);

  if (lines[0] !== `# ${manifest.name}`) errors.push(message('DOC_E004', `: line 1 is not "# ${manifest.name}"`));
  else if (llms.summary === '') errors.push(message('DOC_E004', ': no "> " line after the title'));

  const found = [...llms.sections.keys()];
  const wanted: string[] = [...LLMS_SECTIONS, ...(found.at(-1) === OPTIONAL ? [OPTIONAL] : [])];
  if (found.join('\n') !== wanted.join('\n')) {
    errors.push(message('DOC_E005', `: found ${found.length === 0 ? 'none' : found.join(', ')}`));
  }

  const imports = llms.sections.get('Import paths');
  if (imports) {
    const named = namedSubpaths(imports, manifest.name);
    const exported = Object.keys(manifest.exports).filter(key => key !== './package.json' && !key.includes('*'));
    const missing = exported.filter(key => !named.has(key)).toSorted();
    const extra = [...named].filter(key => !exported.includes(key)).toSorted();
    if (missing.length > 0 || extra.length > 0) {
      const parts = [
        ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
        ...(extra.length > 0 ? [`extra ${extra.join(', ')}`] : []),
      ];
      errors.push(message('DOC_E006', `: ${parts.join('; ')}`));
    }
  }

  const count = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (count > LLMS_MAX_LINES || bytes > LLMS_MAX_BYTES) {
    errors.push(message('DOC_E007', `: ${String(count)} lines, ${String(bytes)} bytes`));
  } else if (count > LLMS_WARN_LINES) {
    warnings.push(message('DOC_W002', `: ${String(count)} lines`));
  }

  const links = checkLinks(dir, LLMS, text);
  errors.push(...links.errors);
  warnings.push(...forwardLooking(LLMS, text));
  return { errors, warnings, targets: links.targets };
}

/** `dot <verb> --json`, then a `jq` path under `.data`, on one line. */
function namesDotCommand(lines: readonly string[], verb: 'explain' | 'doctor'): boolean {
  const command = new RegExp(String.raw`dot ${verb}\b[^\n]*--json[^\n]*\|\s*jq\b[^\n]*\.data\b`);
  return lines.some(line => command.test(line));
}

function checkGuide(dir: string, manifest: Manifest, text: string): CheckResult & { targets: string[] } {
  const errors: string[] = [];
  const sections = h2Sections(text);
  const found = [...sections.keys()];

  const missing = GUIDE_SECTIONS.filter(name => !sections.has(name));
  if (missing.length > 0) {
    errors.push(message('DOC_E010', `: missing ${missing.join(', ')}`));
  } else {
    const required = new Set<string>(GUIDE_SECTIONS);
    const order = found.filter(name => required.has(name));
    if (order.join('\n') !== GUIDE_SECTIONS.join('\n')) {
      errors.push(message('DOC_E010', `: order is ${order.join(', ')}`));
    }
  }

  const verify = sections.get('Verify');
  if (verify && './dot' in manifest.exports) {
    const absent = (['explain', 'doctor'] as const)
      .filter(verb => !namesDotCommand(verify, verb))
      .map(verb => `dot ${verb} --json | jq .data...`);
    if (absent.length > 0) errors.push(message('DOC_E011', `: missing ${absent.join(', ')}`));
  }

  const links = checkLinks(dir, GUIDE, text);
  errors.push(...links.errors);
  return { errors, warnings: forwardLooking(GUIDE, text), targets: links.targets };
}

/** Turns one `files` pattern into a test, the way npm reads it: a name also ships everything under it. */
function filesPattern(pattern: string): RegExp {
  const clean = pattern.replace(/^\.?\//, '').replace(/\/+$/, '');
  const source = clean
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map(part => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
    })
    .join('');
  return new RegExp(`^${source}(?:/.*)?$`);
}

/** True when npm would pack `file` (package-relative, `/`-separated) under this `files` list. */
export function isShipped(files: readonly string[] | undefined, file: string): boolean {
  if (files === undefined) return true;
  let shipped = false;
  for (const entry of files) {
    const negated = entry.startsWith('!');
    if (filesPattern(negated ? entry.slice(1) : entry).test(file)) shipped = !negated;
  }
  return shipped;
}

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

export function checkDocs(dir: string, manifest: Manifest): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const shipped: string[] = [];

  if (!existsSync(path.join(dir, 'README.md'))) errors.push(message('DOC_E001'));

  const llms = readIfExists(path.join(dir, LLMS));
  if (llms === undefined) {
    errors.push(message('DOC_E002'));
  } else {
    const result = checkLlms(dir, manifest, llms);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    shipped.push(LLMS, ...result.targets);
  }

  const guide = readIfExists(path.join(dir, GUIDE));
  if (guide === undefined) {
    errors.push(message('DOC_E003'));
  } else {
    const result = checkGuide(dir, manifest, guide);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    shipped.push(GUIDE, ...result.targets);
  }

  // npm always packs the README, so a link to it never needs a `files` entry.
  const unshipped = [...new Set(shipped)]
    .filter(file => file !== 'README.md' && !isShipped(manifest.files, file))
    .toSorted();
  if (unshipped.length > 0) errors.push(message('DOC_E012', `: ${unshipped.join(', ')}`));

  const script = manifest.scripts['test:docs'];
  if (script === undefined) errors.push(message('DOC_E013', ': add "test:docs": "arki-doc-examples"'));
  else if (!script.startsWith('arki-doc-examples')) errors.push(message('DOC_E013', ': it must run arki-doc-examples'));

  return { errors: [...new Set(errors)], warnings };
}
