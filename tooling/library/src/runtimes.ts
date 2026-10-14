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
 *   hermes   an IIFE bundle with a console shim under `$HERMES_BIN`
 *
 * A missing engine prints `INCOMPLETE: <leg> (<reason>)`. That is not a
 * failure unless `--require-all` is given. Any real failure exits 1 and names the leg.
 *
 *   arki-runtimes [--only node,bun] [--require-all]
 *
 * To get a Hermes binary matching React Native 0.86 (Hermes V1):
 *   git clone --depth 1 --branch hermes-v250829098.0.17 https://github.com/facebook/hermes
 *   cmake -S hermes -B hermes-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_INTL=ON
 *   ninja -C hermes-build hermes      # then HERMES_BIN=hermes-build/bin/hermes
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { expectImportPure } from '@arki/ts/testing';

import type { Manifest } from './manifest';
import { hasNoNpmDependencies, readManifest, runtimeEntry } from './manifest';
import { isAdapterSubpath } from './adapters';
import { complain, say } from './report';

const LEGS = ['purity', 'node', 'bun', 'deno', 'browser', 'hermes'] as const;
type Leg = (typeof LEGS)[number];

/** The leg could not run because its engine is missing. */
class Incomplete extends Error {}

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
function smoke(command: string, args: readonly string[], cwd: string): void {
  const { output, status } = run(command, args, cwd);
  const summary = output.split('\n').find(line => SUMMARY.test(line));
  if (status !== 0 || !summary) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(status)}\n${output}`);
  }
  say(`  ${summary}`);
}

function requireSmokeFile({ cwd }: Context): void {
  if (!existsSync(path.join(cwd, SMOKE))) throw new Error(`${SMOKE} is missing`);
}

/**
 * Bundles the smoke file once per engine. Browser and Hermes get the browser
 * build of every dependency; Deno gets the node build, which it runs through its
 * `node:` support (a browser build may touch `document`). `bun:*` stays external:
 * the portable code guards it at runtime.
 */
const bundles = new Map<string, string>();
function bundle(context: Context, name: 'browser' | 'hermes' | 'deno'): string {
  const cached = bundles.get(name);
  if (cached) return cached;
  const outfile = `${OUT}/${name}.js`;
  const target = name === 'deno' ? '--target=node' : '--target=browser';
  const format = name === 'hermes' ? ['--format=iife'] : [];
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

function hermes(context: Context): void {
  const binary = process.env['HERMES_BIN'] ?? 'hermes';
  if (spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0) {
    throw new Incomplete('no Hermes binary; set HERMES_BIN');
  }
  const file = bundle(context, 'hermes');
  // Hermes has no ES modules and no `console`.
  const shim = 'globalThis.console = { log: print, warn: print, error: print };\n';
  const script = `${OUT}/hermes-run.js`;
  mkdirSync(path.join(context.cwd, OUT), { recursive: true });
  writeFileSync(path.join(context.cwd, script), shim + readFileSync(path.join(context.cwd, file), 'utf8'));
  smoke(binary, [script], context.cwd);
}

const legRunners: Record<Leg, (context: Context) => void | Promise<void>> = {
  purity,
  node: ({ cwd }) => smoke('node', [SMOKE], cwd),
  bun: ({ cwd }) => smoke('bun', [SMOKE], cwd),
  deno,
  browser,
  hermes,
};

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
    options: { only: { type: 'string' }, 'require-all': { type: 'boolean', default: false } },
  });
  const cwd = process.cwd();
  const context: Context = { cwd, manifest: readManifest(cwd) };
  mkdirSync(path.join(cwd, OUT), { recursive: true });
  requireSmokeFile(context);

  const failed: Leg[] = [];
  const incomplete: Leg[] = [];
  for (const leg of selectLegs(values.only)) {
    say(`${context.manifest.name} ${leg}`);
    try {
      await legRunners[leg](context);
    } catch (error) {
      if (error instanceof Incomplete) {
        say(`INCOMPLETE: ${leg} (${error.message})`);
        incomplete.push(leg);
      } else {
        complain(`FAILED: ${leg}\n${error instanceof Error ? error.message : String(error)}`);
        failed.push(leg);
      }
    }
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
