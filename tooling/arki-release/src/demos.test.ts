/**
 * Unit tests for the demo registry, proof map and demo lag.
 * Fixtures are built in temp dirs; nothing touches the real demos.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateConfig } from './config';
import { computeLag, DEMO_ERROR_CODES, demosUsing, evaluateDemoLag, loadDemos, validateDemoConfig } from './demos';
import type { DemoConfig, DemoUse } from './demos';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-demos-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function makeDemo(): void {
  write('packages/dot/package.json', JSON.stringify({ version: '0.6.1' }));
  write(
    'demos/shop/arki.deps.json',
    JSON.stringify({
      linkRoot: '../../packages',
      packages: {
        '@arki/dot': { path: 'dot', version: '0.4.1' },
        '@arki/feature': { path: 'feature', version: '0.0.2' },
      },
    }),
  );
  write('demos/shop/backend/src/app.ts', "import { dot } from '@arki/dot/plugin';\nimport { f } from '@arki/feature/dot';\nimport { x } from '@arki/log';\n");
}

const config: DemoConfig = { demos: [{ name: 'shop', repo: 'acme/shop', path: 'demos/shop' }] };

describe('loadDemos', () => {
  it('survives a missing demo folder with a warning', async () => {
    // Why: nested demo repos are not in CI clones; the release must not crash there.
    const registry = await loadDemos(root, config);
    expect(registry.demos[0]?.present).toBe(false);
    expect(registry.errors.map(e => [e.code, e.severity])).toEqual([[DEMO_ERROR_CODES.demoMissing, 'warning']]);
  });

  it('warns about a pin that is not a package and an import that is not pinned', async () => {
    // Why: @arki/feature was renamed away; a stale pin must be visible, not a crash.
    makeDemo();
    const registry = await loadDemos(root, config);
    const codes = registry.errors.map(e => `${e.code}:${e.target}`);
    expect(codes).toContain(`${DEMO_ERROR_CODES.pinNotAPackage}:@arki/feature`);
    expect(codes).toContain(`${DEMO_ERROR_CODES.importNotPinned}:@arki/log`);
    expect(registry.demos[0]?.pins.get('@arki/dot')).toEqual({ pinned: '0.4.1', sourceVersion: '0.6.1' });
  });
});

describe('demosUsing', () => {
  it('unions real imports with configured proofs', async () => {
    // Why: some packages are exercised by behaviour, not by an import in demo source.
    makeDemo();
    const registry = await loadDemos(root, {
      ...config,
      proofs: { '@arki/queue': [{ demo: 'shop', scenario: 'retry on failure' }] },
    });
    expect(demosUsing(registry, '@arki/dot')).toEqual([
      { demo: 'shop', via: ['import'], scenarios: [], pinned: '0.4.1' },
    ]);
    expect(demosUsing(registry, '@arki/queue')).toEqual([
      { demo: 'shop', via: ['proof'], scenarios: ['retry on failure'] },
    ]);
    expect(demosUsing(registry, '@arki/money')).toEqual([]);
  });
});

describe('computeLag', () => {
  it('counts minors within a major and treats a newer pin as zero lag', () => {
    // Why: only trailing pins matter; a demo ahead of the candidate is fine.
    expect(computeLag('0.4.1', '0.6.1')).toEqual({ majorsBehind: 0, minorsBehind: 2 });
    expect(computeLag('0.9.0', '0.6.1')).toEqual({ majorsBehind: 0, minorsBehind: 0 });
    expect(computeLag('1.0.0', '2.0.0')).toEqual({ majorsBehind: 1, minorsBehind: 0 });
    expect(computeLag('latest', '1.0.0')).toBeUndefined();
  });
});

describe('evaluateDemoLag', () => {
  const use = (pinned: string): DemoUse => ({ demo: 'shop', via: ['import'], scenarios: [], pinned });
  const run = (pinned: string, extra: { blocking?: boolean; allowReason?: string } = {}) =>
    evaluateDemoLag({
      pkg: '@arki/dot',
      candidateVersion: '0.6.1',
      uses: [use(pinned)],
      blocking: extra.blocking ?? false,
      ...(extra.allowReason === undefined ? {} : { allowReason: extra.allowReason }),
    });

  it('warns for dot 0.4.1 against 0.6.1 (the real-world case)', () => {
    // Why: two minors behind is the situation the dimension exists to surface.
    expect(run('0.4.1').status).toBe('warn');
  });

  it('passes within one minor and for packages no demo uses', () => {
    // Why: a one-minor trail is normal between waves; unused packages must not be noisy.
    expect(run('0.5.0').status).toBe('pass');
    expect(evaluateDemoLag({ pkg: '@arki/x', candidateVersion: '1.0.0', uses: [], blocking: true }).status).toBe('pass');
  });

  it('is warning-only while demoLagBlocking is false, fails when it is true', () => {
    // Why: the dimension only becomes a gate after two waves have shipped with it.
    expect(run('0.3.0').status).toBe('warn');
    expect(run('0.3.0', { blocking: true }).status).toBe('fail');
  });

  it('lets an allow-reason turn a blocking fail into a warning and records the reason', () => {
    // Why: ship --allow-demo-lag is the audited escape hatch.
    const result = run('0.3.0', { blocking: true, allowReason: 'demo rewrite in progress' });
    expect(result.status).toBe('warn');
    expect(result.details).toContain('demo rewrite in progress');
  });

  it('fails on the worst demo when blocking, using the worst demo', () => {
    // Why: one stale demo must not hide behind a fresh one.
    const result = evaluateDemoLag({
      pkg: '@arki/dot',
      candidateVersion: '0.9.0',
      uses: [use('0.8.0'), { demo: 'old', via: ['import'], scenarios: [], pinned: '0.5.0' }],
      blocking: true,
    });
    expect(result.status).toBe('fail');
    expect(result.details).toContain('old');
  });

  it('warns, not passes, when a using demo has no readable pin', () => {
    // Why: unknown lag must not read as green.
    const result = evaluateDemoLag({
      pkg: '@arki/q',
      candidateVersion: '1.0.0',
      uses: [{ demo: 'shop', via: ['proof'], scenarios: ['s'] }],
      blocking: true,
    });
    expect(result.status).toBe('warn');
  });
});

describe('validateDemoConfig', () => {
  it('accepts a good config and rejects unknown proof demos', () => {
    // Why: a typo in a proof would silently drop a package from the proof map.
    expect(Array.isArray(validateDemoConfig({ ...config, demoLagBlocking: false }))).toBe(false);
    const bad = validateDemoConfig({ ...config, proofs: { '@arki/queue': [{ demo: 'nope', scenario: 's' }] } });
    expect(Array.isArray(bad) && bad[0]?.code).toBe(DEMO_ERROR_CODES.invalidConfig);
  });

  it('is called by validateConfig and reported as CFG_E007', () => {
    // Why: config loading is the single place that fails loudly on a bad config.
    const base = {
      publicTreePath: '.release/x',
      publicMetadataDefaults: {
        license: 'MIT',
        homepage: 'h',
        keywords: [],
        repository: { type: 'git', url: 'u' },
        bugs: { url: 'u' },
        publishConfig: { access: 'public' },
      },
      waves: [{ id: 'foundation', label: 'W', packages: ['@arki/a'] }],
    };
    expect(() => validateConfig({ ...base, demos: [{ name: 'x' }] })).toThrow(/DEMO_E001/);
    expect(() => validateConfig({ ...base, demos: config.demos })).not.toThrow();
  });
});
