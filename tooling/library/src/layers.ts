#!/usr/bin/env bun
/**
 * `arki-layers`: the blocking layer and dependency gate for `packages/*`,
 * `tooling/*` and `fleet/*` (RFC `arki-structure` P2, P3, §4). Run once from the repo root.
 * `turbo boundaries` stays an advisory report: it counts optional peers as
 * undeclared and cannot see export entries.
 *
 * Config is read, never copied: a workspace's tag comes from its `turbo.json`
 * `tags`, the allow/deny rules from the root `turbo.json` `boundaries.tags`.
 *
 * An export entry is an **adapter** when its first subpath segment is in
 * `ADAPTERS` (`./react`, `./node`, ...), else **portable**. The import graph of
 * each entry is followed through relative imports. Bare specifiers become package
 * names (scoped aware). Ignored: any `scheme:` specifier (`node:`, `bun:`, `virtual:`), Node builtins, `bun`, `#x`,
 * `@/x`, `~x`, and the package's own name.
 *
 * Type-only imports (`import type`, `export type`, all-inline-`type` imports,
 * `import('x')` types) are treated exactly like value imports, with one carve-out
 * in L001 below: they ship in `.d.ts`, so a consumer needs the package too.
 *
 * Rules (each finding is file:line plus a rule id):
 *   L001 undeclared      imported package is in none of dependencies, devDependencies,
 *                        peerDependencies, optionalDependencies. A file reachable from an
 *                        entry may not rely on devDependencies, except a type-only import
 *                        of a `@types/*` package, or of a package whose `@types/<it>` is
 *                        declared. Files no entry reaches (tests, bench, scripts, configs)
 *                        may use devDependencies.
 *   L002 layer           a workspace import whose tag the importer's tag rules deny. An
 *                        adapter-only file may import its package's declared optional peers
 *                        whatever their layer. Skipped when the package is only a
 *                        devDependency (L004 reports that edge).
 *   L003 portable-peer   a portable entry reaches an optional peer (breaks when the peer is absent).
 *   L004 dev-edge        a workspace package in devDependencies whose tag the rules deny.
 *   L005 fleet           an `@arki/*` package lists `@fleet/*` in any dependency bucket, or
 *                        imports it. The direction is apps -> fleet -> Arki, never back. No
 *                        adapter or devDependency exemption, and no baseline entry waives it.
 *
 *   arki-layers [--json] [--package @arki/name] [--root <dir>]
 *
 * A baseline file (`tooling/library/layers-baseline.json`) may list known findings,
 * each with a reason; only findings not in it fail the run. An entry that matches no live
 * finding is stale and also fails the run, so the baseline only shrinks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';

import type { ExportTarget, Manifest } from './manifest';
import { isAdapterSubpath } from './adapters';
import { leaves, readManifest } from './manifest';
import { complain, say } from './report';

export type Rule = 'L001' | 'L002' | 'L003' | 'L004' | 'L005';

export type Finding = {
  readonly package: string;
  readonly rule: Rule;
  /** Path relative to the repo root. */
  readonly file: string;
  readonly line: number;
  /** The imported package (or the devDependency for L004). */
  readonly specifier: string;
  readonly message: string;
  /** Which kind of export entry reaches the file: `none` for tests, bench, scripts and configs. */
  readonly reach: 'portable' | 'adapter' | 'none';
};

type TagRule = { readonly allow: readonly string[]; readonly deny: readonly string[] };
export type TagRules = Readonly<Record<string, TagRule>>;

type Workspace = {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly tags: readonly string[];
};

const turboSchema = z.object({
  tags: z.array(z.string()).optional(),
  boundaries: z
    .object({
      tags: z
        .record(
          z.string(),
          z.object({
            dependencies: z
              .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

function readTurbo(dir: string): z.infer<typeof turboSchema> {
  const file = path.join(dir, 'turbo.json');
  if (!existsSync(file)) return {};
  return turboSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function readTagRules(root: string): TagRules {
  const rules: Record<string, TagRule> = {};
  for (const [tag, rule] of Object.entries(readTurbo(root).boundaries?.tags ?? {})) {
    rules[tag] = { allow: rule.dependencies?.allow ?? [], deny: rule.dependencies?.deny ?? [] };
  }
  return rules;
}

/** Workspaces we never walk: their source is huge data. They still count as import targets. */
const SKIP_WALK = new Set(['@fleet/dictionary', '@fleet/dictionaries']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.cache', '.turbo', '.output', 'coverage', '.git']);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** A wildcard export never counts tests, specs or benches as entries. */
const TEST_FILE = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/;
const MAX_FILE_BYTES = 1_000_000;

function loadWorkspaces(root: string): Map<string, Workspace> {
  const found = new Map<string, Workspace>();
  // `fleet/` may not exist yet; a missing group is skipped like any other.
  for (const group of ['packages', 'tooling', 'fleet']) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const dir = path.join(base, entry.name);
      if (!entry.isDirectory() || !existsSync(path.join(dir, 'package.json'))) continue;
      const manifest = readManifest(dir);
      found.set(manifest.name, { dir, manifest, tags: readTurbo(dir).tags ?? [] });
    }
  }
  return found;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts') && statSync(full).size <= MAX_FILE_BYTES) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/** `lazy`: a runtime `import()` call, which loads nothing until it runs. */
type Import = { readonly specifier: string; readonly line: number; readonly typeOnly: boolean; readonly lazy: boolean };

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('x')) return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/** Static `import`/`export ... from`, `import x = require()`, `import('x')` and `import('x')` types with string literals. */
export function parseImports(file: string, text: string): Import[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const found: Import[] = [];
  const add = (literal: ts.Node, typeOnly: boolean, lazy = false): void => {
    if (!ts.isStringLiteralLike(literal)) return;
    found.push({
      specifier: literal.text,
      line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1,
      typeOnly,
      lazy,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allInlineType =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every(element => element.isTypeOnly);
      add(node.moduleSpecifier, clause?.isTypeOnly === true || allInlineType);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const allInlineType =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every(element => element.isTypeOnly);
      add(node.moduleSpecifier, node.isTypeOnly || allInlineType);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first) add(first, false, true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const BUILTINS = new Set(builtinModules.flatMap(name => [name, name.split('/')[0] ?? name]));

/** The npm package name of a bare specifier, or `undefined` when it is not one we track. */
export function packageNameOf(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.startsWith('~')
  ) {
    return undefined;
  }
  // `node:x`, `bun:x`, `virtual:x`, `cloudflare:x`: a scheme, not an npm package.
  if (/^[a-z][a-z0-9+.-]*:/.test(specifier) || specifier === 'bun' || BUILTINS.has(specifier)) return undefined;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    const [scope, name] = parts;
    return scope && scope.length > 1 && name ? `${scope}/${name}` : undefined;
  }
  return parts[0];
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

/** Resolves a relative specifier (or an `exports` source path) to a file that exists, or `undefined`. */
function resolveFile(base: string): string | undefined {
  const isFile = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile();
  if (isFile(base)) return base;
  const ext = path.extname(base);
  const swaps = JS_TO_TS[ext];
  if (swaps) {
    const stem = base.slice(0, -ext.length);
    for (const swap of swaps) if (isFile(stem + swap)) return stem + swap;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(base + extension)) return base + extension;
    if (isFile(path.join(base, `index${extension}`))) return path.join(base, `index${extension}`);
  }
  return undefined;
}

type Entry = { readonly subpath: string; readonly adapter: boolean; readonly file: string };

/** Source-path candidates for an `exports` target: a `src/` path as is, a `dist/` path mapped back to `src/`. */
function sourceCandidates(target: string): string[] {
  const clean = target.replace(/^\.\//, '');
  if (!clean.startsWith('dist/')) return [clean];
  const rest = clean.slice('dist/'.length);
  return rest.startsWith('src/') ? [rest] : [`src/${rest}`, rest];
}

function entriesOf(workspace: Workspace, sourceFiles: readonly string[]): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const push = (subpath: string, file: string): void => {
    const key = `${subpath}\0${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ subpath, adapter: isAdapterSubpath(subpath), file });
  };
  for (const [subpath, target] of Object.entries<ExportTarget>(workspace.manifest.exports)) {
    if (subpath === './package.json') continue;
    const runtime = leaves(target).filter(
      leaf => !leaf.conditions.includes('types') && /\.[cm]?[jt]sx?$/.test(leaf.value) && !leaf.value.endsWith('.d.ts'),
    );
    for (const leaf of runtime) {
      let wildcardMatched = false;
      for (const candidate of sourceCandidates(leaf.value)) {
        if (subpath.includes('*') || candidate.includes('*')) {
          if (wildcardMatched) break;
          // Wildcard target: every source file that matches the pattern is an entry.
          const pattern = new RegExp(
            `^${candidate
              .replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replaceAll('*', '(.+)')
              .replace(/\\\.[cm]?[jt]sx?$/, '\\.[cm]?[jt]sx?')}$`,
          );
          for (const file of sourceFiles) {
            if (TEST_FILE.test(file)) continue;
            const match = pattern.exec(path.relative(workspace.dir, file));
            if (match) {
              wildcardMatched = true;
              push(subpath.replace('*', match[1] ?? ''), file);
            }
          }
        } else {
          const file = resolveFile(path.join(workspace.dir, candidate));
          if (file) {
            push(subpath, file);
            break;
          }
        }
      }
    }
  }
  return entries;
}

/** Tags of the target allow the edge? Deny wins; then at least one tag must be in `allow`. */
export function edgeDenied(rules: TagRules, importerTags: readonly string[], target: Workspace): boolean {
  const targetTags = target.tags;
  if (targetTags.length === 0) return false;
  return importerTags.some(tag => {
    const rule = rules[tag];
    if (!rule) return false;
    const denied = rule.deny.some(item => item === target.manifest.name || targetTags.includes(item));
    if (denied) return true;
    return rule.allow.length > 0 && !targetTags.some(item => rule.allow.includes(item));
  });
}

const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'layers-baseline.json');

const baselineSchema = z.object({
  entries: z.array(
    z.object({
      package: z.string(),
      // L005 (Arki -> fleet) is left out on purpose: no baseline entry may waive it.
      rule: z.enum(['L001', 'L002', 'L003', 'L004']),
      specifier: z.string(),
      file: z.string().optional(),
      reason: z.string().min(1),
    }),
  ),
});

export type BaselineEntry = z.infer<typeof baselineSchema>['entries'][number];

export function readBaseline(file: string): BaselineEntry[] {
  if (!existsSync(file)) return [];
  return baselineSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).entries;
}

function baselined(entries: readonly BaselineEntry[], finding: Finding): boolean {
  return entries.some(
    entry =>
      entry.package === finding.package &&
      entry.rule === finding.rule &&
      entry.specifier === finding.specifier &&
      (entry.file === undefined || entry.file === finding.file),
  );
}

/**
 * Baseline entries that match no live finding. A fixed finding must leave the baseline, so the
 * file only shrinks. With `only` set, entries of other packages are not judged: their findings
 * were never computed.
 */
export function staleBaselineEntries(
  entries: readonly BaselineEntry[],
  findings: readonly Finding[],
  only?: string,
): BaselineEntry[] {
  return entries.filter(
    entry =>
      (only === undefined || entry.package === only) &&
      !findings.some(
        finding =>
          entry.package === finding.package &&
          entry.rule === finding.rule &&
          entry.specifier === finding.specifier &&
          (entry.file === undefined || entry.file === finding.file),
      ),
  );
}

/** A package that `@arki/*` packages may never depend on (`fleet/<name>` = `@fleet/<name>`). */
const isFleetPackage = (name: string): boolean => name.startsWith('@fleet/');

export type CheckOptions = { readonly root: string; readonly only?: string | undefined };

export function checkLayers({ root, only }: CheckOptions): Finding[] {
  const rules = readTagRules(root);
  const workspaces = loadWorkspaces(root);
  const findings: Finding[] = [];

  for (const [name, workspace] of workspaces) {
    if (only && name !== only) continue;
    const { manifest } = workspace;
    const rel = (file: string): string => path.relative(root, file);
    const isArki = name.startsWith('@arki/');

    // L005: an Arki package never depends on a fleet package, in any bucket.
    if (isArki) {
      const buckets = {
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        peerDependencies: manifest.peerDependencies,
        optionalDependencies: manifest.optionalDependencies,
      };
      for (const [bucket, deps] of Object.entries(buckets)) {
        for (const dep of Object.keys(deps).filter(isFleetPackage)) {
          findings.push({
            package: name,
            rule: 'L005',
            file: rel(path.join(workspace.dir, 'package.json')),
            line: 1,
            specifier: dep,
            reach: 'none',
            message: `${bucket} lists ${dep}; an @arki/* package may never depend on @fleet/*`,
          });
        }
      }
    }

    if (SKIP_WALK.has(name)) continue;
    const optionalPeers = new Set([...manifest.optionalPeers].filter(peer => peer in manifest.peerDependencies));
    const declared = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.peerDependencies),
      ...Object.keys(manifest.optionalDependencies),
    ]);
    const devDeclared = new Set(Object.keys(manifest.devDependencies));

    // L004: a denied workspace package in devDependencies.
    for (const dev of devDeclared) {
      const target = workspaces.get(dev);
      if (target && edgeDenied(rules, workspace.tags, target)) {
        findings.push({
          package: name,
          rule: 'L004',
          file: rel(path.join(workspace.dir, 'package.json')),
          line: 1,
          specifier: dev,
          reach: 'none',
          message: `devDependency ${dev} (${target.tags.join(',')}) is denied for ${workspace.tags.join(',')}`,
        });
      }
    }

    const sourceFiles = listSourceFiles(workspace.dir);
    const imports = new Map<string, Import[]>();
    const importsOf = (file: string): Import[] => {
      const cached = imports.get(file);
      if (cached) return cached;
      const parsed = parseImports(file, readFileSync(file, 'utf8'));
      imports.set(file, parsed);
      return parsed;
    };

    // Reachability: which files each kind of entry reaches.
    const reach = new Map<string, { portable: boolean; adapter: boolean }>();
    for (const entry of entriesOf(workspace, sourceFiles)) {
      const kind = entry.adapter ? 'adapter' : 'portable';
      const stack = [entry.file];
      while (stack.length > 0) {
        const file = stack.pop();
        if (file === undefined) break;
        const state = reach.get(file) ?? { portable: false, adapter: false };
        if (state[kind]) continue;
        reach.set(file, { ...state, [kind]: true });
        for (const item of importsOf(file)) {
          if (!item.specifier.startsWith('.')) continue;
          const next = resolveFile(path.resolve(path.dirname(file), item.specifier));
          if (next) stack.push(next);
        }
      }
    }

    for (const file of sourceFiles) {
      const state = reach.get(file);
      const reachable = state !== undefined;
      for (const item of importsOf(file)) {
        const dep = packageNameOf(item.specifier);
        if (!dep || dep === name) continue;
        const reachKind = state?.portable ? 'portable' : state?.adapter ? 'adapter' : 'none';
        const where = { package: name, file: rel(file), line: item.line, specifier: dep, reach: reachKind } as const;

        const inDeps = declared.has(dep);
        const inDev = devDeclared.has(dep);
        const typesBacked =
          item.typeOnly &&
          (dep.startsWith('@types/') ||
            declared.has(`@types/${dep.replace(/^@/, '').replace('/', '__')}`) ||
            devDeclared.has(`@types/${dep.replace(/^@/, '').replace('/', '__')}`));
        if (!inDeps && !(inDev && (!reachable || typesBacked)) && !typesBacked) {
          findings.push({
            ...where,
            rule: 'L001',
            message: inDev
              ? `${dep} is only a devDependency but ${reachable ? 'an export entry reaches this file' : 'this file ships'}`
              : `${dep} is not declared in package.json`,
          });
        }

        // L005 for imports: apart from L002, so its adapter-peer and dev-only exemptions never apply.
        if (isArki && isFleetPackage(dep)) {
          findings.push({ ...where, rule: 'L005', message: `an @arki/* package may never import ${dep} (@fleet/*)` });
        }

        // A lazy import() of an optional peer is how a portable entry stays usable without it (RFC P3).
        if (optionalPeers.has(dep) && state?.portable && !item.lazy) {
          findings.push({
            ...where,
            rule: 'L003',
            message: `a portable entry reaches optional peer ${dep}; move this code behind an adapter entry`,
          });
        }

        const target = workspaces.get(dep);
        if (target && edgeDenied(rules, workspace.tags, target)) {
          const adapterPeerOk = optionalPeers.has(dep) && state !== undefined && !state.portable;
          const devOnly = inDev && !inDeps;
          if (!adapterPeerOk && !devOnly) {
            findings.push({
              ...where,
              rule: 'L002',
              message: `${workspace.tags.join(',')} may not import ${dep} (${target.tags.join(',')})`,
            });
          }
        }
      }
    }
  }

  return findings
    .filter(
      (finding, index, all) =>
        all.findIndex(
          other =>
            other.package === finding.package &&
            other.rule === finding.rule &&
            other.file === finding.file &&
            other.line === finding.line &&
            other.specifier === finding.specifier,
        ) === index,
    )
    .toSorted((a, b) => a.package.localeCompare(b.package) || a.file.localeCompare(b.file) || a.line - b.line);
}

function findRepoRoot(from: string): string {
  let current = path.resolve(from);
  while (!existsSync(path.join(current, 'turbo.json')) || !existsSync(path.join(current, 'packages'))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('arki-layers: run it inside the monorepo (no root turbo.json found)');
    current = parent;
  }
  return current;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      package: { type: 'string' },
      root: { type: 'string' },
      baseline: { type: 'string' },
    },
  });
  const root = values.root ? path.resolve(values.root) : findRepoRoot(process.cwd());
  const all = checkLayers({ root, only: values.package });
  const baseline = readBaseline(values.baseline ? path.resolve(values.baseline) : BASELINE_FILE);
  const findings = all.filter(finding => !baselined(baseline, finding));
  const known = all.length - findings.length;
  const stale = staleBaselineEntries(baseline, all, values.package);

  const byRule: Record<string, number> = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;

  if (values.json) {
    say(JSON.stringify({ findings, counts: byRule, baselined: known, stale }, null, 2));
    return findings.length > 0 || stale.length > 0 ? 1 : 0;
  }

  const byPackage = Map.groupBy(findings, finding => finding.package);
  for (const [pkg, items] of byPackage) {
    complain(`${pkg} (${String(items.length)})`);
    for (const item of items) complain(`  ${item.file}:${String(item.line)}  ${item.rule}  ${item.message}`);
  }
  for (const entry of stale) {
    complain(
      `stale baseline entry: ${entry.package} ${entry.rule} ${entry.specifier}${entry.file ? ` (${entry.file})` : ''}; it no longer matches a finding, delete it from layers-baseline.json`,
    );
  }
  const summary = Object.entries(byRule)
    .map(([rule, count]) => `${rule}=${String(count)}`)
    .join(' ');
  if (findings.length > 0) {
    complain(
      `arki-layers: ${String(findings.length)} finding(s) in ${String(byPackage.size)} package(s) [${summary}]${known > 0 ? `, ${String(known)} baselined` : ''}`,
    );
    return 1;
  }
  if (stale.length > 0) {
    complain(`arki-layers: ${String(stale.length)} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}`);
    return 1;
  }
  say(`arki-layers: ok${known > 0 ? ` (${String(known)} baselined)` : ''}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
