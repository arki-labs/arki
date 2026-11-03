/**
 * The build-time helpers of `@arki/tanstack-start/vite`, checked on real
 * `vite build` output of small fixtures: compiled Zod must reach the server
 * bundle (shim first, before Zod itself) and never the client bundle. The win
 * of each helper only exists if the output shows it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InlineConfig } from 'vite';
import { build, createServer, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

import { fleetVite, oneChunkPerRoute, zodCompiled } from './vite';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'vite');

/** The code of every chunk a silent, in-memory `vite build` of the fixture project produced. */
async function builtCode(config: InlineConfig): Promise<string> {
  const result = await build({
    ...config,
    root: fixtures,
    configFile: false,
    logLevel: 'silent',
    build: { ...config.build, write: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap(output => ('output' in output ? output.output : []))
    .map(chunk => ('code' in chunk ? chunk.code : ''))
    .join('\n');
}

describe('zodCompiled', () => {
  it('server bundle: every Zod import loads the compile shim first', async () => {
    const code = await builtCode({
      plugins: [zodCompiled()],
      build: { ssr: 'zod-server.ts' },
    });
    const shim = code.search(/["']zod\/compile["']/);
    const zod = code.search(/from\s*["']zod["']/);
    expect(shim).toBeGreaterThanOrEqual(0);
    expect(zod).toBeGreaterThanOrEqual(0);
    expect(shim).toBeLessThan(zod);
  });

  it('client bundle: untouched, the browser keeps the plain parser', async () => {
    const code = await builtCode({
      plugins: [zodCompiled()],
      build: { rollupOptions: { input: path.join(fixtures, 'zod-client.ts'), external: ['zod', 'zod/compile'] } },
    });
    expect(code).toMatch(/from\s*["']zod["']/);
    expect(code).not.toMatch(/zod\/compile/);
  });

  it('dev server: serves server modules unchanged instead of crashing every app on `vite dev`', async () => {
    const server = await createServer({
      root: fixtures,
      configFile: false,
      logLevel: 'silent',
      plugins: [zodCompiled()],
      server: { middlewareMode: true, ws: false },
    });
    try {
      const result = await server.environments.ssr.transformRequest('/zod-server.ts');
      expect(result?.code).not.toMatch(/zod\/compile/);
    } finally {
      await server.close();
    }
  });
});

describe('oneChunkPerRoute', () => {
  it('groups the loader with the component and leaves the fallbacks on their own', () => {
    expect(oneChunkPerRoute.defaultBehavior).toEqual([
      ['loader', 'component'],
      ['pendingComponent'],
      ['errorComponent'],
      ['notFoundComponent'],
    ]);
  });
});

describe('fleetVite', () => {
  // An @arki package left external is imported from node_modules at prerender, where Node will not
  // strip the TypeScript some of them publish: the SSR build must bundle every one, and still bundle
  // what the app lists itself.
  it('SSR bundles every @arki package next to the app’s own noExternal entries', async () => {
    const config = await resolveConfig(
      { root: fixtures, configFile: false, logLevel: 'silent', plugins: [fleetVite()], ssr: { noExternal: ['react-tweet'] } },
      'build',
    );
    const noExternal = config.environments['ssr']?.resolve.noExternal;
    const bundled = (name: string) =>
      noExternal === true ||
      (Array.isArray(noExternal) && noExternal.some(entry => (typeof entry === 'string' ? entry === name : entry.test(name))));

    expect(bundled('@arki/icons')).toBe(true);
    expect(bundled('@arki/seo')).toBe(true);
    expect(bundled('react-tweet')).toBe(true);
    expect(bundled('react')).toBe(false);
  });
});
