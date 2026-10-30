#!/usr/bin/env bun
/**
 * `arki-runtimes`: proves the package in the current directory runs on every
 * runtime it claims (RFC `arki-structure` §6). Legs, in order:
 *
 *   purity   import every export entry of the built output in a fresh process
 *            with an empty environment (`expectImportPure` from `@arki/ts/testing`)
 *   node     `node scripts/smoke.mjs`
 *   bun      `bun scripts/smoke.mjs`
 *   deno     unbundled when the package has no npm dependencies, else a
 *            `bun build --target=node` bundle
 *   browser  that bundle in headless Chromium (Playwright)
 *   hermes   an ESM bundle (react-native condition, wrapped for top-level await,
 *            with the host shims of `hermes-host.ts`), run through React Native's
 *            Babel step, under `$HERMES_BIN`
 *
 * A missing engine prints `INCOMPLETE: <leg> (<reason>)`. That is not a
 * failure unless `--require-all` is given. Any real failure exits 1 and names the leg.
 * A package can narrow its engines with `"arki": { "runtimes": [...] }` in package.json;
 * a leg outside that list prints `out of scope` and passes.
 *
 *   arki-runtimes [--only node,bun] [--require-all] [--write-readme]
 *
 * `--write-readme` writes one row per engine (result, version tested, UTC date) between
 * `<!-- runtimes:start -->` and `<!-- runtimes:end -->` in README.md. Engines not run
 * in this invocation (`--only`) keep their existing row.
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

import { expectImportPure } from '@arki/ts/testing';
import { transformAsync } from '@babel/core';
import { build } from 'esbuild';

import type { Manifest, Runtime } from './manifest';
import { isAdapterSubpath } from './adapters';
import { HERMES_FAILURE_MARKER, hermesScript } from './hermes-host';
import { hasNoNpmDependencies, readManifest, runtimeEntry } from './manifest';
import { complain, say } from './report';

const LEGS = ['purity', 'node', 'bun', 'deno', 'browser', 'hermes'] as const;
type Leg = (typeof LEGS)[number];

/** True when the package claims the engine behind `leg`. `purity` has no engine and always runs. */
export function isLegInScope(leg: Leg, runtimes: ReadonlySet<Runtime>): boolean {
  return leg === 'purity' || runtimes.has(leg);
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
export function updateRuntimesSection(readme: string, fresh: readonly RuntimeRow[], order: readonly string[]): string {
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
  return `${readme.slice(0, start + RUNTIMES_START.length)}\n${renderRuntimesTable(rows)}\n${readme.slice(end)}`;
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
const SMOKE = 'scripts/smoke.mjs';
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

/**
 * Bundles the smoke file once per engine. Browser and Hermes get the browser
 * build of every dependency (Hermes also the `react-native` condition, since it runs inside React Native); Deno gets the node build, which it runs through its
 * `node:` support (a browser build may touch `document`). `bun:*` stays external:
 * the portable code guards it at runtime.
 */
const bundles = new Map<string, string>();
function bundle(context: Context, name: 'browser' | 'hermes' | 'deno'): string {
  const cached = bundles.get(name);
  if (cached) return cached;
  const outfile = `${OUT}/${name}.js`;
  const target = name === 'deno' ? '--target=node' : '--target=browser';
  const format = name === 'hermes' ? HERMES_BUNDLE_ARGS : [];
  const { output, status } = run(
    'bun',
    ['build', SMOKE, target, '--external', 'bun:*', ...format, `--outfile=${outfile}`],
    context.cwd,
  );
  if (status !== 0) throw new Error(`bundling for ${name} failed\n${output}`);
  bundles.set(name, outfile);
  return outfile;
}

/** An adapter whose platform piece is absent here (an optional peer, an unbuilt native addon). */
const UNLOADABLE = /Cannot find (?:module|package)|No native build|dlopen|\.node['"]? was compiled/;

function purity({ cwd, manifest }: Context): void {
  const entries = new Map<string, string>();
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

function deno(context: Context): void {
  const { cwd, manifest } = context;
  if (hasNoNpmDependencies(manifest)) {
    say('  mode: unbundled (no npm dependencies)');
    smoke('deno', ['run', '--no-config', '--node-modules-dir=manual', '-A', SMOKE], cwd);
  } else {
    say('  mode: bundled for node (npm dependencies; Deno cannot read catalog: versions)');
    smoke('deno', ['run', '--no-config', '-A', bundle(context, 'deno')], cwd);
  }
}

async function browser(context: Context): Promise<void> {
  const file = bundle(context, 'browser');
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
    await page.setContent('<!doctype html><title>smoke</title>');
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

async function hermes(context: Context): Promise<void> {
  const binary = process.env['HERMES_BIN'] ?? 'hermes';
  if (spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0) {
    throw new Incomplete('no Hermes binary; set HERMES_BIN');
  }
  const file = bundle(context, 'hermes');
  // Hermes has no ES modules, no `console` and no top-level `await`: run the ESM bundle inside an async function.
  const script = `${OUT}/hermes-run.js`;
  mkdirSync(path.join(context.cwd, OUT), { recursive: true });
  const source = hermesScript(readFileSync(path.join(context.cwd, file), 'utf8'));
  // Same step Metro runs for a release build; see the header for why Hermes needs it.
  const transformed = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    compact: false,
    sourceType: 'script',
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

const legRunners: Record<Leg, (context: Context) => void | Promise<void>> = {
  purity,
  node: ({ cwd }) => smoke('node', [SMOKE], cwd),
  bun: ({ cwd }) => smoke('bun', [SMOKE], cwd),
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

  const failed: Leg[] = [];
  const incomplete: Leg[] = [];
  const rows: RuntimeRow[] = [];
  const date = new Date().toISOString().slice(0, 10);
  for (const leg of selectLegs(values.only)) {
    say(`${context.manifest.name} ${leg}`);
    if (!isLegInScope(leg, context.manifest.runtimes)) {
      say(`  out of scope: package.json "arki.runtimes" does not list ${leg}`);
      if (leg !== 'purity') rows.push({ runtime: leg, result: 'n/a', version: '-', date });
      continue;
    }
    try {
      await legRunners[leg](context);
      if (leg !== 'purity') {
        const version = leg === 'browser' ? `Chromium ${chromiumVersion ?? 'unknown'}` : engineVersion(leg, cwd);
        rows.push({ runtime: leg, result: 'pass', version, date });
      }
    } catch (error) {
      if (error instanceof Incomplete) {
        say(`INCOMPLETE: ${leg} (${error.message})`);
        incomplete.push(leg);
        rows.push({ runtime: leg, result: 'not run', version: '-', date });
      } else {
        complain(`FAILED: ${leg}\n${error instanceof Error ? error.message : String(error)}`);
        failed.push(leg);
        const version = leg === 'browser' ? `Chromium ${chromiumVersion ?? 'unknown'}` : engineVersion(leg, cwd);
        rows.push({ runtime: leg, result: 'fail', version, date });
      }
    }
  }

  if (values['write-readme']) {
    const readme = path.join(cwd, 'README.md');
    writeFileSync(readme, updateRuntimesSection(readFileSync(readme, 'utf8'), rows, LEGS));
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
