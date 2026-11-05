#!/usr/bin/env bun
/**
 * `arki-runtimes`: proves the package in the current directory runs on every
 * runtime it claims (RFC `arki-structure` §6). Legs, in order:
 *
 *   purity   import every export entry of the built output in a fresh process
 *            with an empty environment (`expectImportPure` from `@arki/ts/testing`).
 *            A React Native package (`arki.runtimes` is Hermes only) is left to the
 *            Hermes leg: `react-native` is Flow source that only Metro loads.
 *   node     `node scripts/smoke.mjs`
 *   bun      `bun scripts/smoke.mjs`
 *   deno     `deno run --no-config --node-modules-dir=manual`, unbundled: Deno
 *            reads the installed `node_modules`, as a Deno app does
 *   browser  a `bun build --target=browser` bundle in headless Chromium (Playwright)
 *   hermes   an ESM bundle (react-native condition, wrapped for top-level await,
 *            with the host shims of `hermes-host.ts`), run through React Native's
 *            Babel step, under `$HERMES_BIN`. A React Native package
 *            is bundled the way Metro does (iOS and native file extensions, JSX in
 *            `.js`), with `react-native` itself given by the host
 *            (`REACT_NATIVE_HOST_MODULE`): this runner has no React Native native runtime.
 *
 * Entry smoke files. `scripts/smoke.mjs` proves the package on every engine it
 * claims. An export key in `"arki": { "entryRuntimes": { "./geocoding": [...] } }`
 * runs on fewer engines: its checks live in `scripts/smoke/geocoding.mjs`
 * (`entrySmokeFile`), which runs only on those engines, and the package smoke
 * must not import that entry. An `arki.bundlerOnly` key may have such a file too;
 * it then runs as a bundle on every engine (`--target=node` for Node, Bun and
 * Deno), since a bundler is how that entry is loaded.
 *
 * A missing engine prints `INCOMPLETE: <leg> (<reason>)`. That is not a
 * failure unless `--require-all` is given. Any real failure exits 1 and names the leg.
 * A package can narrow its engines with `"arki": { "runtimes": [...] }` in package.json;
 * a leg outside that list prints `out of scope` and passes.
 *
 *   arki-runtimes [--only node,bun] [--require-all] [--write-readme]
 *
 * `--write-readme` writes one row per engine (result, version tested, UTC date) between
 * `<!-- runtimes:start -->` and `<!-- runtimes:end -->` in README.md, and one line per
 * entry smoke file saying where that entry runs. Engines not run in this invocation
 * (`--only`) keep their existing row. A row passes only when every smoke file that
 * claims the engine passed.
 *
 * The Hermes leg mirrors an Expo release build (iOS, Hermes V1), because that is how
 * our apps ship: the script goes through `babel-preset-expo` with the caller Metro
 * passes, before Hermes runs it. That preset fixes three Hermes V1 bugs
 * (250829098.0.17): an async arrow with non-simple (destructured or default)
 * parameters resolves to `undefined`, a class inside `finally` breaks, and `super`
 * in an object accessor breaks. It also compiles class static blocks, which Hermes
 * rejects. A bare React Native app on `@react-native/babel-preset` still rejects
 * class static blocks.
 *
 * To get a Hermes V1 runner: download the official `hermes-ios` Maven artifact and
 * build the small JSI runner around it; steps in `hermes-runner/README.md`.
 * Then `HERMES_BIN=<path to run>`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Plugin } from 'esbuild';
import { transformAsync } from '@babel/core';
import { build } from 'esbuild';

import { expectImportPure } from '@arki/ts/testing';

import type { Manifest, Runtime } from './manifest';
import { isAdapterSubpath } from './adapters';
import { HERMES_FAILURE_MARKER, hermesScript, REACT_NATIVE_HOST_MODULE } from './hermes-host';
import { isReactNativePackage, readManifest, runtimeEntry } from './manifest';
import { complain, say } from './report';

const LEGS = ['purity', 'node', 'bun', 'deno', 'browser', 'hermes'] as const;
type Leg = (typeof LEGS)[number];

/** True when the package claims the engine behind `leg`. `purity` has no engine and always runs. */
export function isLegInScope(leg: Leg, runtimes: ReadonlySet<Runtime>): boolean {
  return leg === 'purity' || runtimes.has(leg);
}

const SMOKE = 'scripts/smoke.mjs';

/** The smoke file of one export key: `./react/google-maps` is `scripts/smoke/react/google-maps.mjs`, `.` is `scripts/smoke/index.mjs`. */
export function entrySmokeFile(key: string): string {
  return `scripts/smoke/${key === '.' ? 'index' : key.replace(/^\.\//, '')}.mjs`;
}

/** One smoke file and the engines it runs on. */
export type SmokeUnit = {
  /** The export key the file proves; `undefined` for the package smoke. */
  readonly entry: string | undefined;
  readonly file: string;
  readonly runtimes: ReadonlySet<Runtime>;
  /** Run as a bundle on every engine, because the entry is `arki.bundlerOnly`. */
  readonly bundled: boolean;
};

/**
 * The smoke files of a package: the package smoke on every claimed engine, the file
 * of each `entryRuntimes` key on that entry's engines, and the file of each
 * `bundlerOnly` key that has one, bundled. Throws when an `entryRuntimes` key has no
 * file, because its claim would then have no proof.
 */
export function smokeUnits(manifest: Manifest, exists: (file: string) => boolean): SmokeUnit[] {
  const units: SmokeUnit[] = [{ entry: undefined, file: SMOKE, runtimes: manifest.runtimes, bundled: false }];
  for (const [entry, runtimes] of manifest.entryRuntimes) {
    const file = entrySmokeFile(entry);
    if (!exists(file)) {
      throw new Error(`package.json "arki.entryRuntimes" lists ${entry}; write ${file} to prove it on its engines`);
    }
    units.push({ entry, file, runtimes, bundled: manifest.bundlerOnly.has(entry) });
  }
  for (const entry of manifest.bundlerOnly) {
    const file = entrySmokeFile(entry);
    if (manifest.entryRuntimes.has(entry) || !exists(file)) continue;
    units.push({ entry, file, runtimes: manifest.runtimes, bundled: true });
  }
  return units;
}

/** The README lines under the table: where each entry with its own smoke file runs. */
export function entryNotes(units: readonly SmokeUnit[]): string[] {
  return units.flatMap(unit =>
    unit.entry === undefined
      ? []
      : [
          `- \`${unit.entry}\` runs on ${[...unit.runtimes].join(', ')}${unit.bundled ? ', bundled (bundler-only entry)' : ''} (\`${unit.file}\`).`,
        ],
  );
}

export const RUNTIMES_START = '<!-- runtimes:start -->';
export const RUNTIMES_END = '<!-- runtimes:end -->';

/** What a README row says about one engine. `not run` = engine missing here; `n/a` = package does not claim it. */
export type RuntimeOutcome = 'pass' | 'fail' | 'not run' | 'n/a';

export type RuntimeRow = {
  readonly runtime: string;
  readonly result: RuntimeOutcome;
  readonly version: string;
  /** UTC day, `YYYY-MM-DD`. */
  readonly date: string;
};

const TABLE_HEADER = ['Runtime', 'Result', 'Version tested', 'Date (UTC)'] as const;
const rowLine = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

/** The table between the runtimes markers, one line per row. */
export function renderRuntimesTable(rows: readonly RuntimeRow[]): string {
  return [
    rowLine(TABLE_HEADER),
    rowLine(TABLE_HEADER.map(() => '---')),
    ...rows.map(row => rowLine([row.runtime, row.result, row.version, row.date])),
  ].join('\n');
}

/** Reads the rows back out of a table `renderRuntimesTable` wrote, so a partial run can keep the other engines. */
export function parseRuntimesTable(table: string): RuntimeRow[] {
  const rows: RuntimeRow[] = [];
  for (const line of table.split('\n')) {
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(cell => cell.trim());
    const [runtime, result, version, date] = cells;
    if (cells.length !== 4 || !runtime || !version || !date) continue;
    if (result !== 'pass' && result !== 'fail' && result !== 'not run' && result !== 'n/a') continue;
    rows.push({ runtime, result, version, date });
  }
  return rows;
}

/**
 * Puts `fresh` rows into the marked section of a README. A row for an engine
 * not in `fresh` stays as it was; new engines are appended in `order`.
 * Throws when the markers are missing, repeated or out of order, so a typo
 * never silently skips the update.
 */
export function updateRuntimesSection(
  readme: string,
  fresh: readonly RuntimeRow[],
  order: readonly string[],
  notes: readonly string[] = [],
): string {
  const starts = readme.split(RUNTIMES_START).length - 1;
  const ends = readme.split(RUNTIMES_END).length - 1;
  const start = readme.indexOf(RUNTIMES_START);
  const end = readme.indexOf(RUNTIMES_END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error(`README.md needs exactly one ${RUNTIMES_START} ... ${RUNTIMES_END} pair, in that order`);
  }
  const kept = parseRuntimesTable(readme.slice(start + RUNTIMES_START.length, end));
  const byRuntime = new Map([...kept, ...fresh].map(row => [row.runtime, row]));
  const rows = [...byRuntime.values()].toSorted((a, b) => order.indexOf(a.runtime) - order.indexOf(b.runtime));
  const footer = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
  return `${readme.slice(0, start + RUNTIMES_START.length)}\n${renderRuntimesTable(rows)}${footer}\n${readme.slice(end)}`;
}

/** The leg could not run because its engine is missing. */
class Incomplete extends Error {}

/** Runtime-specific bundling for the Hermes leg. */
export const HERMES_BUNDLE_ARGS = ['--format=esm', '--conditions=react-native'] as const;

/** What Metro passes Babel for a release iOS build on Hermes V1. Babel's `TransformCaller` type lists only a few keys, so this is a variable, not a fresh literal. */
const METRO_RELEASE_CALLER = {
  name: 'metro',
  bundler: 'metro',
  platform: 'ios',
  isDev: false,
  engine: 'hermes',
  unstable_transformProfile: 'hermes-stable',
};

const SUMMARY = /smoke checks passed/;
const OUT = '.cache/runtimes';

type Context = { readonly cwd: string; readonly manifest: Manifest };

function run(command: string, args: readonly string[], cwd: string): { output: string; status: number | null } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    throw new Incomplete(`${command} is not installed`);
  }
  if (result.error) throw result.error;
  return { output: `${result.stdout}${result.stderr}`.trim(), status: result.status };
}

/** Runs a smoke command; it must exit 0 and print the "smoke checks passed" line. */
function smoke(command: string, args: readonly string[], cwd: string, failureMarker?: string): void {
  const { output, status } = run(command, args, cwd);
  const summary = output.split('\n').find(line => SUMMARY.test(line));
  if (status !== 0 || !summary || (failureMarker !== undefined && output.includes(failureMarker))) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(status)}\n${output}`);
  }
  say(`  ${summary}`);
}

function requireSmokeFile({ cwd }: Context): void {
  if (!existsSync(path.join(cwd, SMOKE))) throw new Error(`${SMOKE} is missing`);
}

/** File extensions Metro tries for an iOS build, in its order: platform file, then native file, then the plain one. */
const METRO_SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'] as const;
export const METRO_RESOLVE_EXTENSIONS = [
  ...METRO_SOURCE_EXTENSIONS.map(extension => `.ios${extension}`),
  ...METRO_SOURCE_EXTENSIONS.map(extension => `.native${extension}`),
  ...METRO_SOURCE_EXTENSIONS,
];

/** Gives `react-native` from the host; a deep `react-native/Libraries/...` import needs the native runtime, so it fails the build. */
const reactNativeHostPlugin: Plugin = {
  name: 'react-native-host',
  setup(builder) {
    builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native', namespace: 'react-native-host' }));
    builder.onResolve({ filter: /^react-native\// }, args => ({
      errors: [
        {
          text: `${args.path} (from ${args.importer}) needs the React Native native runtime, which the Hermes runner does not have`,
        },
      ],
    }));
    builder.onLoad({ filter: /.*/, namespace: 'react-native-host' }, () => ({
      contents: REACT_NATIVE_HOST_MODULE,
      loader: 'js',
    }));
  },
};

/** The Hermes bundle of a package that loads `react-native`, resolved and loaded the way Metro does for iOS. */
async function metroBundle(cwd: string, file: string, outfile: string): Promise<void> {
  try {
    await build({
      absWorkingDir: cwd,
      entryPoints: [file],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'esnext',
      conditions: ['react-native'],
      mainFields: ['react-native', 'browser', 'main'],
      resolveExtensions: METRO_RESOLVE_EXTENSIONS,
      // Metro runs Babel on every file, so React Native libraries ship JSX in `.js` and `.mjs`.
      loader: { '.js': 'jsx', '.mjs': 'jsx' },
      jsx: 'automatic',
      external: ['bun:*'],
      plugins: [reactNativeHostPlugin],
      logLevel: 'silent',
    });
  } catch (error) {
    throw new Error(`bundling for hermes failed\n${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/**
 * Bundles a smoke file once per target. Browser and Hermes get the browser build
 * of every dependency (Hermes also the `react-native` condition, since it runs
 * inside React Native); `node` is the bundle a bundler-only entry runs on Node,
 * Bun and Deno. `bun:*` stays external: the portable code guards it at runtime.
 */
const bundles = new Map<string, string>();
async function bundle(context: Context, unit: SmokeUnit, name: 'browser' | 'hermes' | 'node'): Promise<string> {
  const key = `${unit.file}:${name}`;
  const cached = bundles.get(key);
  if (cached) return cached;
  const prefix =
    unit.entry === undefined
      ? ''
      : `entry-${path
          .relative('scripts/smoke', unit.file)
          .replace(/\.mjs$/, '')
          .replaceAll('/', '-')}.`;
  const outfile = `${OUT}/${prefix}${name}.js`;
  if (name === 'hermes' && isReactNativePackage(context.manifest)) {
    await metroBundle(context.cwd, unit.file, outfile);
  } else {
    const target = name === 'node' ? '--target=node' : '--target=browser';
    const format = name === 'hermes' ? HERMES_BUNDLE_ARGS : [];
    const { output, status } = run(
      'bun',
      ['build', unit.file, target, '--external', 'bun:*', ...format, `--outfile=${outfile}`],
      context.cwd,
    );
    if (status !== 0) throw new Error(`bundling for ${name} failed\n${output}`);
  }
  bundles.set(key, outfile);
  return outfile;
}

/** An adapter whose platform piece is absent here (an optional peer, an unbuilt native addon). */
const UNLOADABLE = /Cannot find (?:module|package)|No native build|dlopen|\.node['"]? was compiled/;

function purity({ cwd, manifest }: Context): void {
  const entries = new Map<string, string>();
  // React Native ships Flow source that only Metro loads, so Bun cannot import a React Native package;
  // its Hermes leg imports the entries in a host with no environment instead.
  if (isReactNativePackage(manifest)) {
    say('  a React Native package (arki.runtimes is hermes only): the hermes leg imports its entries');
    return;
  }
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath.includes('*')) continue;
    const entry = runtimeEntry(target);
    if (entry) entries.set(subpath, path.resolve(cwd, entry));
  }
  const missing = [...entries.values()].filter(entry => !existsSync(entry));
  if (missing.length > 0) throw new Error(`built output is missing (run the build first): ${missing.join(', ')}`);

  // One process per entry, so one adapter that cannot load here does not hide the others.
  const unloadable: string[] = [];
  for (const [subpath, entry] of entries) {
    try {
      expectImportPure([entry]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAdapter = isAdapterSubpath(subpath);
      if (!isAdapter || !UNLOADABLE.test(message)) throw new Error(`${subpath}: ${message}`, { cause: error });
      unloadable.push(subpath);
    }
  }
  say(`  ${String(entries.size - unloadable.length)} export entries import cleanly with an empty environment`);
  if (unloadable.length > 0) throw new Incomplete(`adapter entries cannot load here: ${unloadable.join(', ')}`);
}

async function nodeLike(command: 'node' | 'bun', context: Context, unit: SmokeUnit): Promise<void> {
  smoke(command, [unit.bundled ? await bundle(context, unit, 'node') : unit.file], context.cwd);
}

async function deno(context: Context, unit: SmokeUnit): Promise<void> {
  if (unit.bundled) {
    smoke('deno', ['run', '--no-config', '-A', await bundle(context, unit, 'node')], context.cwd);
  } else {
    smoke('deno', ['run', '--no-config', '--node-modules-dir=manual', '-A', unit.file], context.cwd);
  }
}

/** The page the browser leg runs in. Playwright answers it, so nothing listens on localhost; localhost is a secure context. */
const BROWSER_PAGE = 'http://localhost/arki-runtimes/';

async function browser(context: Context, unit: SmokeUnit): Promise<void> {
  const file = await bundle(context, unit, 'browser');
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    throw new Incomplete('Playwright is not installed');
  }
  let session;
  try {
    session = await chromium.launch();
  } catch (error) {
    throw new Incomplete(
      `Chromium cannot start: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
    );
  }
  chromiumVersion = session.version();
  const logs: string[] = [];
  try {
    const page = await session.newPage();
    page.on('console', message => logs.push(message.text()));
    page.on('pageerror', error => logs.push(`pageerror: ${error.message}`));
    // A page with a real origin, as an app has: `about:blank` is opaque, so the browser denies it storage (IndexedDB, localStorage).
    await page.route(BROWSER_PAGE, route =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>smoke</title>' }),
    );
    await page.goto(BROWSER_PAGE);
    await page.addScriptTag({ type: 'module', content: readFileSync(path.join(context.cwd, file), 'utf8') });
    const deadline = Date.now() + 60_000;
    while (
      Date.now() < deadline &&
      !logs.some(line => SUMMARY.test(line) || line.startsWith('pageerror') || line.startsWith('FAIL'))
    ) {
      await page.waitForTimeout(50);
    }
  } finally {
    await session.close();
  }
  const summary = logs.find(line => SUMMARY.test(line));
  if (!summary || logs.some(line => line.startsWith('FAIL') || line.startsWith('pageerror'))) {
    throw new Error(`browser smoke did not pass\n${logs.join('\n')}`);
  }
  say(`  ${summary}`);
}

async function hermes(context: Context, unit: SmokeUnit): Promise<void> {
  const binary = process.env['HERMES_BIN'] ?? 'hermes';
  if (spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0) {
    throw new Incomplete('no Hermes binary; set HERMES_BIN');
  }
  const file = await bundle(context, unit, 'hermes');
  // Hermes has no ES modules, no `console` and no top-level `await`: run the ESM bundle inside an async function.
  const script = file.replace(/hermes\.js$/, 'hermes-run.js');
  mkdirSync(path.join(context.cwd, OUT), { recursive: true });
  const source = hermesScript(readFileSync(path.join(context.cwd, file), 'utf8'));
  // Same step Metro runs for a release build; see the header for why Hermes needs it.
  const transformed = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    compact: false,
    // A bundle that reads `import.meta` parses as a module, so Expo's `import.meta` transform runs as it does in an app.
    sourceType: 'unambiguous',
    presets: ['babel-preset-expo'],
    caller: METRO_RELEASE_CALLER,
    filename: path.join(context.cwd, script),
    comments: false,
    sourceMaps: false,
    envName: 'production',
    cwd: context.cwd,
  });
  if (transformed?.code == null) throw new Error('Babel produced no output for the Hermes script');
  // Babel leaves `require('@babel/runtime/helpers/...')` calls (Metro bundles them); inline them from this package.
  const inlined = await build({
    stdin: { contents: transformed.code, resolveDir: import.meta.dirname, sourcefile: 'hermes-run.js' },
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'esnext',
    write: false,
    logLevel: 'silent',
  });
  const [output] = inlined.outputFiles;
  if (!output) throw new Error('esbuild produced no output for the Hermes script');
  writeFileSync(path.join(context.cwd, script), output.text);
  smoke(binary, [script], context.cwd, HERMES_FAILURE_MARKER);
}

/** The engine's own version string, or `unknown` when it cannot be asked. */
function engineVersion(leg: Leg, cwd: string): string {
  const command: Record<Leg, readonly [string, readonly string[]] | undefined> = {
    purity: undefined,
    node: ['node', ['--version']],
    bun: ['bun', ['--version']],
    deno: ['deno', ['--version']],
    browser: undefined,
    hermes: [process.env['HERMES_BIN'] ?? 'hermes', ['-version']],
  };
  const entry = command[leg];
  if (!entry) return 'unknown';
  const result = spawnSync(entry[0], entry[1], { cwd, encoding: 'utf8' });
  const first = `${result.stdout}${result.stderr}`
    .split('\n')
    .map(line => line.trim())
    .find(Boolean);
  // `deno 2.9.7 (stable, release, ...)`: keep the number only.
  const cleaned = first?.replace(/^(?:Hermes|deno)\s+/i, '').replace(/\s+\(.*$/, '');
  return result.status === 0 && cleaned ? cleaned : 'unknown';
}

const legRunners: Record<Runtime, (context: Context, unit: SmokeUnit) => Promise<void>> = {
  node: (context, unit) => nodeLike('node', context, unit),
  bun: (context, unit) => nodeLike('bun', context, unit),
  deno,
  browser,
  hermes,
};

/** Chromium's version, read while the browser leg has it open. */
let chromiumVersion: string | undefined;

function selectLegs(only: string | undefined): readonly Leg[] {
  if (!only) return LEGS;
  const wanted = only.split(',').map(name => name.trim());
  const known = new Set<string>(LEGS);
  const unknown = wanted.filter(name => !known.has(name));
  if (unknown.length > 0) throw new Error(`unknown leg(s): ${unknown.join(', ')} (legs: ${LEGS.join(', ')})`);
  return LEGS.filter(leg => wanted.includes(leg));
}

/** Runs one engine leg over every smoke file that claims the engine. */
async function runEngine(leg: Runtime, context: Context, units: readonly SmokeUnit[]): Promise<void> {
  for (const unit of units) {
    if (unit.entry !== undefined) say(`  ${unit.entry} (${unit.file}${unit.bundled ? ', bundled' : ''})`);
    await legRunners[leg](context, unit);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      'require-all': { type: 'boolean', default: false },
      'write-readme': { type: 'boolean', default: false },
    },
  });
  const cwd = process.cwd();
  const context: Context = { cwd, manifest: readManifest(cwd) };
  mkdirSync(path.join(cwd, OUT), { recursive: true });
  requireSmokeFile(context);
  const units = smokeUnits(context.manifest, file => existsSync(path.join(cwd, file)));

  const failed: Leg[] = [];
  const incomplete: Leg[] = [];
  const rows: RuntimeRow[] = [];
  const date = new Date().toISOString().slice(0, 10);
  for (const leg of selectLegs(values.only)) {
    say(`${context.manifest.name} ${leg}`);
    const inScope = leg === 'purity' ? [] : units.filter(unit => unit.runtimes.has(leg));
    if (leg !== 'purity' && inScope.length === 0) {
      say(`  out of scope: package.json "arki.runtimes" does not list ${leg}`);
      rows.push({ runtime: leg, result: 'n/a', version: '-', date });
      continue;
    }
    try {
      if (leg === 'purity') purity(context);
      else await runEngine(leg, context, inScope);
      if (leg !== 'purity') {
        const version = leg === 'browser' ? `Chromium ${chromiumVersion ?? 'unknown'}` : engineVersion(leg, cwd);
        rows.push({ runtime: leg, result: 'pass', version, date });
      }
    } catch (error) {
      if (error instanceof Incomplete) {
        say(`INCOMPLETE: ${leg} (${error.message})`);
        incomplete.push(leg);
        if (leg !== 'purity') rows.push({ runtime: leg, result: 'not run', version: '-', date });
      } else {
        complain(`FAILED: ${leg}\n${error instanceof Error ? error.message : String(error)}`);
        failed.push(leg);
        if (leg !== 'purity') {
          const version = leg === 'browser' ? `Chromium ${chromiumVersion ?? 'unknown'}` : engineVersion(leg, cwd);
          rows.push({ runtime: leg, result: 'fail', version, date });
        }
      }
    }
  }

  if (values['write-readme']) {
    const readme = path.join(cwd, 'README.md');
    writeFileSync(readme, updateRuntimesSection(readFileSync(readme, 'utf8'), rows, LEGS, entryNotes(units)));
    say(`arki-runtimes: wrote the runtimes table to README.md`);
  }

  if (failed.length > 0) {
    complain(`arki-runtimes: FAILED legs: ${failed.join(', ')}`);
    return 1;
  }
  if (incomplete.length > 0 && values['require-all']) {
    complain(`arki-runtimes: --require-all, but INCOMPLETE legs: ${incomplete.join(', ')}`);
    return 1;
  }
  say(`arki-runtimes: ok${incomplete.length > 0 ? ` (INCOMPLETE: ${incomplete.join(', ')})` : ''}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
