import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import type { RuntimeRow } from './runtimes';
import { appResult, pickSimulator, readApp, schemeName, tarballName } from './hermes-app';
import { HERMES_FAILURE_MARKER, hermesScript, REACT_NATIVE_HOST_MODULE } from './hermes-host';
import { isReactNativePackage, readManifest, RUNTIMES } from './manifest';
import {
  entryNotes,
  entrySmokeFile,
  HERMES_BUNDLE_ARGS,
  hermesVersionLabel,
  isLegInScope,
  METRO_RESOLVE_EXTENSIONS,
  parseRuntimesTable,
  renderRuntimesTable,
  RUNTIMES_END,
  RUNTIMES_START,
  smokeUnits,
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

describe('per-entry engines (arki.entryRuntimes)', () => {
  const exports = { '.': './dist/index.js', './geocoding': './dist/geocoding.js', './react': './dist/react.js' };

  it('reads the engines of an entry, so an entry that needs Node builtins can claim fewer engines than its package', () => {
    const manifest = manifestWith({ exports, arki: { entryRuntimes: { './geocoding': ['node', 'bun', 'deno'] } } });
    expect([...(manifest.entryRuntimes.get('./geocoding') ?? [])]).toEqual(['node', 'bun', 'deno']);
    expect(manifest.entryRuntimes.has('.')).toBe(false);
  });

  it('rejects a key that is not an export, so a typo cannot leave the real entry on the package claim', () => {
    expect(() => manifestWith({ exports, arki: { entryRuntimes: { './geocode': ['node'] } } })).toThrow(
      /entryRuntimes lists \.\/geocode, but exports has no such key/,
    );
  });

  it('rejects an engine the package does not claim, so an entry can only narrow the package claim', () => {
    expect(() =>
      manifestWith({ exports, arki: { runtimes: ['node', 'bun'], entryRuntimes: { './geocoding': ['deno'] } } }),
    ).toThrow(/gives \.\/geocoding the engine deno, which arki.runtimes does not claim/);
    expect(() => manifestWith({ exports, arki: { entryRuntimes: { './geocoding': [] } } })).toThrow(
      /not a valid package manifest/,
    );
  });

  it('names one smoke file per export key, nested like the key, so two keys never share a file', () => {
    expect(entrySmokeFile('./geocoding')).toBe('scripts/smoke/geocoding.mjs');
    expect(entrySmokeFile('./react/google-maps')).toBe('scripts/smoke/react/google-maps.mjs');
    expect(entrySmokeFile('.')).toBe('scripts/smoke/index.mjs');
  });

  it('runs an entry smoke file only on its engines and the package smoke on all of them', () => {
    const manifest = manifestWith({ exports, arki: { entryRuntimes: { './geocoding': ['node', 'bun', 'deno'] } } });
    const units = smokeUnits(manifest, () => true);
    expect(units.map(unit => [unit.entry, unit.file, [...unit.runtimes].join(','), unit.bundled])).toEqual([
      [undefined, 'scripts/smoke.mjs', 'node,bun,deno,browser,hermes', false],
      ['./geocoding', 'scripts/smoke/geocoding.mjs', 'node,bun,deno', false],
    ]);
  });

  it('fails when a narrowed entry has no smoke file, because its claim would have no proof', () => {
    const manifest = manifestWith({ exports, arki: { entryRuntimes: { './geocoding': ['node'] } } });
    expect(() => smokeUnits(manifest, file => file === 'scripts/smoke.mjs')).toThrow(
      /write scripts\/smoke\/geocoding.mjs/,
    );
  });

  it('bundles the smoke file of a bundler-only entry on every engine, since a bundler is how that entry loads', () => {
    const manifest = manifestWith({ exports, arki: { bundlerOnly: ['./react', './geocoding'] } });
    const units = smokeUnits(manifest, file => file !== 'scripts/smoke/geocoding.mjs');
    expect(units.map(unit => [unit.entry, unit.bundled, unit.runtimes.size])).toEqual([
      [undefined, false, 5],
      ['./react', true, 5],
    ]);
  });

  it('writes one README line per entry smoke file and replaces it on the next run', () => {
    const manifest = manifestWith({
      exports,
      arki: { bundlerOnly: ['./react'], entryRuntimes: { './geocoding': ['node', 'bun', 'deno'] } },
    });
    const notes = entryNotes(smokeUnits(manifest, () => true));
    expect(notes).toEqual([
      '- `./geocoding` runs on node, bun, deno (`scripts/smoke/geocoding.mjs`).',
      '- `./react` runs on node, bun, deno, browser, hermes, bundled (bundler-only entry) (`scripts/smoke/react.mjs`).',
    ]);
    const row = { runtime: 'node', result: 'pass', version: 'v1', date: '2026-01-01' } as const;
    const readme = `# x\n\n${RUNTIMES_START}\n${RUNTIMES_END}\n`;
    const once = updateRuntimesSection(readme, [row], ['node'], notes);
    const twice = updateRuntimesSection(once, [row], ['node'], notes);
    expect(twice).toBe(once);
    expect(once.split('./geocoding').length - 1).toBe(1);
  });
});

describe('React Native packages', () => {
  it('treats a Hermes-only package as React Native, so only it is bundled like Metro and skips the Bun import', () => {
    expect(isReactNativePackage(manifestWith({ arki: { runtimes: ['hermes'] } }))).toBe(true);
    expect(isReactNativePackage(manifestWith({ arki: { runtimes: ['bun', 'hermes'] } }))).toBe(false);
    expect(isReactNativePackage(manifestWith({}))).toBe(false);
  });

  it('resolves the iOS file, then the native file, then the plain one, as Metro does', () => {
    const order = ['.ios.js', '.native.js', '.js'].map(extension => METRO_RESOLVE_EXTENSIONS.indexOf(extension));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /** Loads the host module as CommonJS, the way the bundle requires it. */
  function reactNativeHost(): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(REACT_NATIVE_HOST_MODULE, { module, Proxy, Object, Error, String });
    return module.exports;
  }

  it('gives no native module, so a library sees the store module as unlinked', () => {
    const host = reactNativeHost();
    expect(Object.keys(host['NativeModules'] as object)).toEqual([]);
  });

  it("selects the iOS value the way React Native's Platform does", () => {
    const platform = reactNativeHost()['Platform'] as { OS: string; select: (spec: object) => unknown };
    expect(platform.OS).toBe('ios');
    expect(platform.select({ ios: 1, native: 2, default: 3 })).toBe(1);
    expect(platform.select({ native: 2, default: 3 })).toBe(2);
    expect(platform.select({ default: 3 })).toBe(3);
  });

  it('throws on any other export, so a smoke never passes on a stand-in for React Native itself', () => {
    expect(() => reactNativeHost()['View']).toThrow(/react-native View is not in the Hermes smoke host/);
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

  it('provides queueMicrotask as React Native does, so a package that defers delivery runs on the Hermes leg', async () => {
    const lines = await runLikeHermes(
      hermesScript(`
        const order = [];
        setTimeout(() => console.log(order.join()), 1);
        queueMicrotask(() => order.push('micro'));
        order.push('sync');
      `),
      '',
      20,
      1,
    );
    expect(lines).toEqual(['sync,micro']);
  });

  it('reports a throw in a queued microtask, so a lost error cannot pass the leg', async () => {
    const lines = await runLikeHermes(hermesScript("queueMicrotask(() => { throw new Error('micro'); });"), '', 50);
    expect(lines.join('\n')).toContain(HERMES_FAILURE_MARKER);
  });

  it('provides performance.now as React Native does, so a stopwatch library does not reach for process.hrtime', async () => {
    const lines = await runLikeHermes(
      hermesScript('const start = performance.now(); console.log(typeof start, performance.now() >= start);'),
    );
    expect(lines).toEqual(['number true']);
  });

  it("provides React Native's URL, so URL schemas parse an http base URL on the Hermes leg", async () => {
    const lines = await runLikeHermes(
      hermesScript(`
        const url = new URL('http://user@localhost:8080/v1?q=1#top');
        console.log(url.protocol, url.hostname, url.port, url.pathname, url.search, url.hash, url.username);
        console.log(new URL('https://example.com').href, new URL('/a', 'https://example.com/').href);
      `),
    );
    expect(lines).toEqual(['http: localhost 8080 /v1 ?q=1 #top user', 'https://example.com/ https://example.com/a']);
  });

  it('leaves a host queueMicrotask, performance and URL alone, so the shim never masks the platform', async () => {
    const lines = await runLikeHermes(
      hermesScript('console.log(queueMicrotask.isReal, performance.isReal, URL.isReal);'),
      'globalThis.queueMicrotask = Object.assign(() => {}, { isReal: true }); globalThis.performance = { isReal: true }; globalThis.URL = class { static isReal = true; };',
    );
    expect(lines).toEqual(['true true true']);
  });

  it("installs Expo's import.meta registry, so code that reads import.meta.env optionally runs as in an Expo app", async () => {
    const lines = await runLikeHermes(
      hermesScript(
        'print(String(globalThis.__ExpoImportMetaRegistry.url), String(globalThis.__ExpoImportMetaRegistry.env?.DEV));',
      ),
    );
    expect(lines).toEqual(['null undefined']);
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

describe('the Hermes app proof (arki.hermesApp)', () => {
  function appDir(dependency: string, name = 'Native UI Smoke'): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'arki-hermes-app-'));
    writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ expo: { name, ios: { bundleIdentifier: 'dev.arki.smoke' } } }),
    );
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@arki/native-ui': dependency } }));
    return dir;
  }

  it('reads the app folder from the claim, so a React Native package can prove its components where Fabric exists', () => {
    expect(manifestWith({ arki: { runtimes: ['hermes'], hermesApp: 'app' } }).hermesApp).toBe('app');
    expect(manifestWith({ arki: { runtimes: ['hermes'] } }).hermesApp).toBeUndefined();
  });

  it('refuses an app on a package that does not claim Hermes, because only the Hermes leg runs it', () => {
    expect(() => manifestWith({ arki: { runtimes: ['node'], hermesApp: 'app' } })).toThrow(/hermesApp needs hermes/);
  });

  it('makes the app install the packed package, so the app proves what npm ships and not the workspace source', () => {
    expect(tarballName('@arki/native-ui')).toBe('arki-native-ui.tgz');
    expect(readApp(appDir('file:.cache/arki-native-ui.tgz'), '@arki/native-ui')).toEqual({
      scheme: 'NativeUISmoke',
      bundleId: 'dev.arki.smoke',
      tarball: '.cache/arki-native-ui.tgz',
    });
    expect(() => readApp(appDir('workspace:*'), '@arki/native-ui')).toThrow(/must depend on/);
  });

  it('builds the scheme expo prebuild makes, which drops spaces and punctuation from the app name', () => {
    expect(schemeName('Native UI-Smoke!')).toBe('NativeUISmoke');
  });

  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
        { udid: 'old', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'pad', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
        { udid: 'gone', name: 'iPhone 17', state: 'Shutdown', isAvailable: false },
        { udid: 'new', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-26-5': [
        { udid: 'watch', name: 'Apple Watch', state: 'Booted', isAvailable: true },
      ],
    },
  });

  it('picks an available iPhone on the newest iOS, so the proof runs on the iOS apps ship to', () => {
    expect(pickSimulator(devices)?.udid).toBe('new');
  });

  it('reuses a booted iPhone, so a run does not boot a second simulator', () => {
    const booted = devices.replace('"udid":"old","name":"iPhone 16","state":"Shutdown"', '"udid":"old","name":"iPhone 16","state":"Booted"');
    expect(pickSimulator(booted)).toMatchObject({ udid: 'old', booted: true });
  });

  it('honours ARKI_RN_SIMULATOR by name or UDID, and finds nothing for an unknown one', () => {
    expect(pickSimulator(devices, 'iPhone 16')?.udid).toBe('old');
    expect(pickSimulator(devices, 'pad')?.name).toBe('iPad Air');
    expect(pickSimulator(devices, 'iPhone 99')).toBeUndefined();
  });

  it('passes only on the summary line with no FAIL line, so one broken component fails the leg', () => {
    expect(appResult('44 smoke checks passed (hermes 250829098.0.17)\n')).toEqual({
      done: true,
      passed: true,
      summary: '44 smoke checks passed (hermes 250829098.0.17)',
    });
    expect(appResult('FAIL select content: did not lay out\n43/44 checks laid out (hermes)\n')).toMatchObject({
      done: true,
      passed: false,
    });
  });

  it('waits while the file is empty or half written, so a slow write is not read as a crash', () => {
    expect(appResult('').done).toBe(false);
    expect(appResult('FAIL button: boom\n').done).toBe(false);
  });

  it('says in the README row which proof ran, so a runner-only pass is never read as a component proof', () => {
    expect(hermesVersionLabel('V1 250829098.0.17')).toBe('V1 250829098.0.17');
    expect(hermesVersionLabel('V1 250829098.0.17', 'pass')).toBe('V1 250829098.0.17, runner + iOS release app');
    expect(hermesVersionLabel('V1 250829098.0.17', 'not run')).toBe('V1 250829098.0.17, runner only (app not run)');
  });
});
