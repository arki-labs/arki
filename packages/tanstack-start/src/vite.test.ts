/**
 * The build-time helpers of `@arki/tanstack-start/vite`, checked on real
 * `vite build` output of small fixtures: compiled Zod must reach the server
 * bundle (shim first, before Zod itself) and never the client bundle. The win
 * of each helper only exists if the output shows it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InlineConfig } from 'vite';
import { build, createServer } from 'vite';
import { describe, expect, it } from 'vitest';

import { oneChunkPerRoute, zodCompiled } from './vite';

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
