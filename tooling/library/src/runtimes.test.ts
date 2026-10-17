import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import type { RuntimeRow } from './runtimes';
import { HERMES_FAILURE_MARKER, hermesScript } from './hermes-host';
import { readManifest, RUNTIMES } from './manifest';
import {
  HERMES_BUNDLE_ARGS,
  isLegInScope,
  parseRuntimesTable,
  renderRuntimesTable,
  updateRuntimesSection,
} from './runtimes';

function manifestWith(extra: object): ReturnType<typeof readManifest> {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-runtimes-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/fixture', ...extra }));
  return readManifest(dir);
}

/** Runs a Hermes script the way the CLI does: only `print` and the JS built-ins exist. */
/**
 * `untilLines`: for scripts that print after their own timers, wait until that
 * many lines arrived (up to 2 s) instead of trusting `settleMs`. Under a loaded
 * machine the script's timers can fire after a fixed settle, which failed the
 * test with no output although the behavior was right.
 */
async function runLikeHermes(script: string, setup = '', settleMs = 20, untilLines = 0): Promise<string[]> {
  const lines: string[] = [];
  const context = vm.createContext({ print: (...args: unknown[]) => lines.push(args.map(String).join(' ')) });
  if (setup) vm.runInContext(setup, context);
  vm.runInContext(script, context);
  await new Promise(resolve => setTimeout(resolve, settleMs));
  const deadline = Date.now() + 2000;
  while (lines.length < untilLines && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  return lines;
}

describe('runtime scope in package.json', () => {
  it('runs every leg when the package declares no scope, so existing packages keep their full proof', () => {
    const manifest = manifestWith({});
    for (const runtime of RUNTIMES) expect(isLegInScope(runtime, manifest.runtimes)).toBe(true);
  });

  it('skips a leg the package left out, so a package that cannot run on Hermes can say so instead of failing', () => {
    const manifest = manifestWith({ arki: { runtimes: ['node', 'bun', 'deno', 'browser'] } });
    expect(isLegInScope('hermes', manifest.runtimes)).toBe(false);
    expect(isLegInScope('node', manifest.runtimes)).toBe(true);
  });

  it('always runs purity, because an import-time side effect is wrong on every engine', () => {
    const manifest = manifestWith({ arki: { runtimes: ['node'] } });
    expect(isLegInScope('purity', manifest.runtimes)).toBe(true);
  });

  it('rejects an unknown engine name, so a typo cannot silently drop a leg', () => {
    expect(() => manifestWith({ arki: { runtimes: ['hermess'] } })).toThrow(/not a valid package manifest/);
    expect(() => manifestWith({ arki: { runtimes: [] } })).toThrow(/not a valid package manifest/);
  });
});

describe('Hermes leg bundling', () => {
  it('bundles for React Native, so packages with a browser build that touches `document` resolve their native build', () => {
    expect(HERMES_BUNDLE_ARGS).toContain('--conditions=react-native');
  });

  it('bundles ESM, because the IIFE format cannot hold top-level await', () => {
    expect(HERMES_BUNDLE_ARGS).toContain('--format=esm');
  });
});

describe('hermesScript', () => {
  it('runs a bundle that uses top-level await', async () => {
    const lines = await runLikeHermes(
      hermesScript('const value = await Promise.resolve(41);\nconsole.log(`done ${value + 1}`);'),
    );
    expect(lines).toEqual(['done 42']);
  });

  it('prints the failure marker when the async main rejects, because Hermes exits 0 on a lost rejection', async () => {
    const lines = await runLikeHermes(hermesScript("await Promise.resolve();\nthrow new Error('boom');"));
    expect(lines.join('\n')).toContain(HERMES_FAILURE_MARKER);
    expect(lines.join('\n')).toContain('boom');
  });

  it('fires timers by delay, not call order, because the CLI default would run a 60 ms timer before a 20 ms one and break debounce', async () => {
    const lines = await runLikeHermes(
      hermesScript(`
        const order = [];
        const started = Date.now();
        setTimeout(() => order.push('slow'), 40);
        setTimeout(() => order.push('fast'), 10);
        const cancelled = setTimeout(() => order.push('cancelled'), 5);
        clearTimeout(cancelled);
        await new Promise(resolve => setTimeout(resolve, 60));
        console.log(order.join(), Date.now() - started >= 55);
      `),
      '',
      200,
    );
    expect(lines).toEqual(['fast,slow true']);
  });

  it('runs promise continuations between timers, as an event loop does', async () => {
    const lines = await runLikeHermes(
      hermesScript(`
        const order = [];
        setTimeout(() => { order.push('timer'); }, 0);
        await Promise.resolve();
        order.push('microtask');
        await new Promise(resolve => setTimeout(resolve, 5));
        console.log(order.join());
      `),
      '',
      20,
      1,
    );
    expect(lines).toEqual(['microtask,timer']);
  });

  it('prints the failure marker when a timer callback throws, so a lost error cannot pass the leg', async () => {
    const lines = await runLikeHermes(hermesScript("setTimeout(() => { throw new Error('late'); }, 1);"), '', 50);
    expect(lines.join('\n')).toContain(HERMES_FAILURE_MARKER);
  });

  it('provides AbortController where the host has none, so sleep(ms, { signal }) can be tested', async () => {
    const lines = await runLikeHermes(
      hermesScript(`
        const controller = new AbortController();
        const seen = [];
        controller.signal.addEventListener('abort', () => seen.push('listener'), { once: true });
        controller.abort();
        controller.abort();
        console.log(controller.signal.aborted, seen.join(), controller.signal.reason.name);
        try { controller.signal.throwIfAborted(); } catch (error) { console.log('threw', error.name); }
        console.log(AbortSignal.abort('why').reason);
      `),
    );
    expect(lines).toEqual(['true listener AbortError', 'threw AbortError', 'why']);
  });

  it('removes a listener on request and honours onabort, as the DOM does', async () => {
    const lines = await runLikeHermes(
      hermesScript(`
        const controller = new AbortController();
        const listener = () => console.log('should not run');
        controller.signal.addEventListener('abort', listener);
        controller.signal.removeEventListener('abort', listener);
        controller.signal.onabort = event => console.log(event.type);
        controller.abort('reason');
        console.log(controller.signal.reason);
      `),
    );
    expect(lines).toEqual(['abort', 'reason']);
  });

  it('leaves the real AbortController alone when the host already has one, so the shim never masks the platform', async () => {
    const lines = await runLikeHermes(
      hermesScript('console.log(AbortController.name, AbortController.isReal === true);'),
      'globalThis.AbortController = class Real { static isReal = true; };',
    );
    expect(lines).toEqual(['Real true']);
  });

  it('refuses to construct AbortSignal directly, like the platform', async () => {
    const lines = await runLikeHermes(
      hermesScript('try { new AbortSignal(); } catch (error) { console.log(error.name); }'),
    );
    expect(lines).toEqual(['TypeError']);
  });
});

describe('runtimes table in the README', () => {
  const order = ['node', 'bun', 'deno', 'browser', 'hermes'];
  const row = (runtime: string, result: RuntimeRow['result'], version: string, date = '2026-10-17'): RuntimeRow => ({
    runtime,
    result,
    version,
    date,
  });
  const page = (inside: string): string =>
    `# demo\n\n<!-- runtimes:start -->\n${inside}<!-- runtimes:end -->\n\n## License\n`;

  it('writes runtime, result, version and UTC date, and keeps the text around the markers', () => {
    // Why: the README claim "runs on Node, Bun, Deno..." must be backed by a dated, versioned proof, not prose.
    const next = updateRuntimesSection(
      page('old\n'),
      [row('node', 'pass', 'v26.1.0'), row('bun', 'fail', '1.4.2')],
      order,
    );
    expect(next).toContain('| node | pass | v26.1.0 | 2026-10-17 |');
    expect(next).toContain('| bun | fail | 1.4.2 | 2026-10-17 |');
    expect(next.startsWith('# demo\n\n<!-- runtimes:start -->\n| Runtime')).toBe(true);
    expect(next.endsWith('<!-- runtimes:end -->\n\n## License\n')).toBe(true);
    expect(updateRuntimesSection(next, [row('node', 'pass', 'v26.1.0'), row('bun', 'fail', '1.4.2')], order)).toBe(
      next,
    );
  });

  it('keeps the rows of engines this run did not touch, so --only does not erase proof', () => {
    // Why: running one engine must not delete the dated evidence for the others.
    const first = updateRuntimesSection(
      page(''),
      [row('node', 'pass', 'v26', '2026-10-01'), row('deno', 'pass', '2.1', '2026-10-01')],
      order,
    );
    const second = updateRuntimesSection(first, [row('node', 'pass', 'v26.2', '2026-10-17')], order);
    expect(parseRuntimesTable(second)).toEqual([
      row('node', 'pass', 'v26.2', '2026-10-17'),
      row('deno', 'pass', '2.1', '2026-10-01'),
    ]);
  });

  it('round-trips through render and parse', () => {
    const rows = [row('node', 'pass', 'v26'), row('hermes', 'not run', '-'), row('browser', 'n/a', '-')];
    expect(parseRuntimesTable(renderRuntimesTable(rows))).toEqual(rows);
  });

  it('refuses a README without exactly one ordered marker pair, so a typo cannot skip the update silently', () => {
    // Why: a silently unwritten table would leave stale proof in the README.
    expect(() => updateRuntimesSection('# demo\n', [], order)).toThrow(/exactly one/);
    expect(() => updateRuntimesSection(page('') + page(''), [], order)).toThrow(/exactly one/);
    expect(() => updateRuntimesSection('<!-- runtimes:end -->\n<!-- runtimes:start -->\n', [], order)).toThrow(
      /exactly one/,
    );
  });
});
