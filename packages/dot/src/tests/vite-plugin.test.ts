/**
 * `@arki/dot/vite` configures the app while Vite builds. A module that
 * exports no app, throws while it loads or does not configure fails
 * `vite build` instead of the first production request, and the manifest
 * plus every projection document land in the server output as files, never
 * in the client output. The build tests run a real `vite build` of the
 * fixture project, once per consumer; the dev test runs the plugin inside a
 * real dev server, where the same mistake is reported instead of thrown.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'vite';
import { build, createLogger, createServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { describeDotApp, dotVite } from '../vite.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vite-app');
const appFile = path.join(fixtures, 'app.ts');

const describeOptions = {
  root: fixtures,
  manifestFile: 'dot-manifest.json',
  projections: true,
  importConfig: undefined,
} as const;

/** A silent Vite logger that keeps every error and info line for the assertions. */
function recordingLogger(): { readonly logger: Logger; readonly lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger('silent');
  logger.error = message => {
    lines.push(message);
  };
  logger.info = message => {
    lines.push(message);
  };
  return { logger, lines };
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'dot-vite-'));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

/** `vite build` of the fixture project for one consumer, into `outDir`; returns the files written. */
async function buildFixture(consumer: 'server' | 'client', app: string, logger = createLogger('silent')) {
  await build({
    root: fixtures,
    configFile: false,
    customLogger: logger,
    build: {
      outDir,
      emptyOutDir: true,
      ...(consumer === 'server'
        ? { ssr: 'server.ts' }
        : { rollupOptions: { input: path.join(fixtures, 'client.ts') } }),
    },
    plugins: [dotVite({ app })],
  });
  return readdir(outDir);
}

describe('describeDotApp', () => {
  it('imports the app through Vite, configures it, and renders the manifest and each projection', async () => {
    const result = await describeDotApp(appFile, describeOptions);
    if (isFailure(result)) throw new Error(result.message);

    expect(result.manifest.app.name).toBe('vite-fixture');
    expect([...result.files.keys()]).toEqual(['dot-manifest.json', 'routes.json']);
    expect(JSON.parse(result.files.get('routes.json') ?? 'null')).toEqual({
      app: 'vite-fixture',
      plugins: ['greeter'],
    });
    // The app's own module is a dependency: the dev server re-checks when it changes.
    expect(result.dependencies.some(file => file.endsWith('app.ts'))).toBe(true);
  });

  it('skips the manifest file and the projections when told to', async () => {
    const result = await describeDotApp(appFile, { ...describeOptions, manifestFile: false, projections: false });
    if (isFailure(result)) throw new Error(result.message);
    expect(result.files.size).toBe(0);
  });

  it('returns dot.app_invalid_export for a module without an app, dot.app_import_failed for one that throws', async () => {
    await expect(describeDotApp(path.join(fixtures, 'broken.ts'), describeOptions)).resolves.toMatchObject({
      code: 'dot.app_invalid_export',
    });
    await expect(describeDotApp(path.join(fixtures, 'throws.ts'), describeOptions)).resolves.toMatchObject({
      code: 'dot.app_import_failed',
      data: { causeMessage: expect.stringContaining('a declaration helper rejected the app') },
    });
  });
});

describe('dotVite in `vite build`', () => {
  it('writes the manifest and the projection documents next to the server chunk', async () => {
    const written = await buildFixture('server', './app.ts');

    expect(written).toEqual(expect.arrayContaining(['dot-manifest.json', 'routes.json']));
    const manifest = JSON.parse(await readFile(path.join(outDir, 'dot-manifest.json'), 'utf8')) as {
      app: { name: string };
      plugins: { name: string }[];
    };
    expect(manifest.app.name).toBe('vite-fixture');
    expect(manifest.plugins.map(entry => entry.name)).toEqual(['greeter']);
  });

  it('writes nothing into the client output: the manifest describes the server', async () => {
    const written = await buildFixture('client', './app.ts');
    expect(written).not.toEqual(expect.arrayContaining(['dot-manifest.json']));
    expect(written.some(file => file.endsWith('.json'))).toBe(false);
  });

  it('fails the build when the module exports no app', async () => {
    await expect(buildFixture('server', './broken.ts')).rejects.toThrow('dot.app_invalid_export');
  });
});

describe('dotVite in `vite dev`', () => {
  it('reports the failure through the logger and keeps the server running', async () => {
    const { logger, lines } = recordingLogger();
    const server = await createServer({
      root: fixtures,
      configFile: false,
      customLogger: logger,
      server: { middlewareMode: true, watch: null, hmr: false, ws: false },
      plugins: [dotVite({ app: './broken.ts' })],
    });
    try {
      await server.environments.ssr.pluginContainer.buildStart({});
      expect(lines.some(line => line.includes('[arki-dot]') && line.includes('dot.app_invalid_export'))).toBe(true);
    } finally {
      await server.close();
    }
  });
});
