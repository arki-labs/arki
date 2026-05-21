/**
 * Tests for the CLI discover module.
 *
 * Each test prepares a temp directory with a synthetic `dot.config.ts` or
 * `src/app.ts` and asks the discover code to find/load it. We avoid spawning
 * the CLI process so failures stay legible.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverApp, loadAppFromFile, resolveAppFile } from '../discover';
import { DotCliError, DotCliErrorCode } from '../error-codes';

// Sources for synthetic app files. They import directly from the kernel
// modules (not the barrel `index.ts`) so vitest's import-analysis doesn't
// trip on transitive JSX deps from the legacy package surface.
const DEFINE_APP_PATH = resolve(__dirname, '..', '..', 'define-app.ts');
const PLUGIN_CONTRACT_PATH = resolve(__dirname, '..', '..', 'plugin-contract.ts');

const BUILDER_SOURCE = `
import { defineApp } from '${DEFINE_APP_PATH}';
import { defineDotPlugin } from '${PLUGIN_CONTRACT_PATH}';
const p = defineDotPlugin({ name: 'p', boot: () => ({}) });
export default defineApp('discovered').use(p);
`;

const FACTORY_SOURCE = `
import { defineApp } from '${DEFINE_APP_PATH}';
import { defineDotPlugin } from '${PLUGIN_CONTRACT_PATH}';
export default async function makeApp() {
  const p = defineDotPlugin({ name: 'p' });
  return defineApp('factory').use(p);
}
`;

const BAD_EXPORT_SOURCE = `
export default { not: 'a DOT app' };
`;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dot-cli-discover-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('resolveAppFile', () => {
  it('honors --app when explicit', async () => {
    const explicit = join(workDir, 'custom-app.ts');
    await writeFile(explicit, BUILDER_SOURCE);
    const resolved = await resolveAppFile({ cwd: workDir, appPath: 'custom-app.ts' });
    expect(resolved).toBe(explicit);
  });

  it('picks dot.config.ts first when present', async () => {
    await writeFile(join(workDir, 'dot.config.ts'), BUILDER_SOURCE);
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(join(workDir, 'src', 'app.ts'), BUILDER_SOURCE);

    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBe(join(workDir, 'dot.config.ts'));
  });

  it('falls back to src/app.ts when dot.config.ts is absent', async () => {
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(join(workDir, 'src', 'app.ts'), BUILDER_SOURCE);

    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBe(join(workDir, 'src', 'app.ts'));
  });

  it('falls back to ./app.ts when neither dot.config.ts nor src/app.ts exist', async () => {
    await writeFile(join(workDir, 'app.ts'), BUILDER_SOURCE);

    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBe(join(workDir, 'app.ts'));
  });

  it('returns null when no app file is discovered', async () => {
    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBeNull();
  });
});

describe('loadAppFromFile', () => {
  it('loads a DotAppBuilder default export', async () => {
    const file = join(workDir, 'app.ts');
    await writeFile(file, BUILDER_SOURCE);
    const app = await loadAppFromFile(file);
    // DotAppBuilder duck-typing: `use` + `configure` + `boot` all functions.
    expect(typeof (app as { use?: unknown }).use).toBe('function');
    expect(typeof (app as { configure?: unknown }).configure).toBe('function');
    expect(typeof (app as { boot?: unknown }).boot).toBe('function');
  });

  it('loads a default-export factory function and awaits its return', async () => {
    const file = join(workDir, 'app.ts');
    await writeFile(file, FACTORY_SOURCE);
    const app = await loadAppFromFile(file);
    expect(typeof (app as { use?: unknown }).use).toBe('function');
  });

  it('throws DOT_CLI_E002 when default export is not a DotApp', async () => {
    const file = join(workDir, 'app.ts');
    await writeFile(file, BAD_EXPORT_SOURCE);
    await expect(loadAppFromFile(file)).rejects.toMatchObject({
      code: DotCliErrorCode.AppInvalidExport,
    });
  });
});

describe('discoverApp', () => {
  it('default discovery: dot.config.ts at cwd is loaded', async () => {
    await writeFile(join(workDir, 'dot.config.ts'), BUILDER_SOURCE);
    const result = await discoverApp({ cwd: workDir });
    expect(result.filePath).toBe(join(workDir, 'dot.config.ts'));
    expect(typeof (result.app as { use?: unknown }).use).toBe('function');
  });

  it('default discovery: src/app.ts is loaded when dot.config.ts is missing', async () => {
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(join(workDir, 'src', 'app.ts'), BUILDER_SOURCE);

    const result = await discoverApp({ cwd: workDir });
    expect(result.filePath).toBe(join(workDir, 'src', 'app.ts'));
  });

  it('honors --app even when default candidates exist', async () => {
    await writeFile(join(workDir, 'dot.config.ts'), BAD_EXPORT_SOURCE);
    const explicit = join(workDir, 'real.ts');
    await writeFile(explicit, BUILDER_SOURCE);

    const result = await discoverApp({ cwd: workDir, appPath: 'real.ts' });
    expect(result.filePath).toBe(explicit);
  });

  it('throws DOT_CLI_E001 with remediation when no app file is found', async () => {
    let thrown: unknown;
    try {
      await discoverApp({ cwd: workDir });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DotCliError);
    const cliErr = thrown as DotCliError;
    expect(cliErr.code).toBe(DotCliErrorCode.AppNotFound);
    expect(cliErr.remediation).toMatch(/dot\.config\.ts|--app/);
    expect(cliErr.docsUrl).toMatch(/^https?:\/\//);
  });
});
