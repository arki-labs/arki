/**
 * Tests for the CLI discover module.
 *
 * Each test prepares a temp directory with a synthetic `dot.config.ts` or
 * `src/app.ts` and asks the discover code to find/load it. We avoid spawning
 * the CLI process so failures stay legible.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { DiscoveryResult } from '../discover.js';
import { discoverApp, loadAppFromFile, resolveAppFile } from '../discover.js';
import { AppImportFailed, AppInvalidExport, AppNotFound } from '../failures.js';

// Sources for synthetic app files. They import directly from the kernel
// modules (not the barrel `index.ts`) so vitest's import-analysis doesn't
// trip on transitive JSX deps from the legacy package surface.
const DEFINE_APP_PATH = path.resolve(__dirname, '..', '..', 'define-app.ts');
const PLUGIN_CONTRACT_PATH = path.resolve(__dirname, '..', '..', 'plugin-contract.ts');

const BUILDER_SOURCE = `
import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
const p = plugin({ name: 'p', boot: () => ({}) });
export default defineApp('discovered').use(p);
`;

const FACTORY_SOURCE = `
import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
export default async function makeApp() {
  const p = plugin({ name: 'p' });
  return defineApp('factory').use(p);
}
`;

const BAD_EXPORT_SOURCE = `
export default { not: 'a DOT app' };
`;

const appSource = (exportLines: string): string => `
import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
const p = plugin({ name: 'p', boot: () => ({}) });
${exportLines}
`;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dot-cli-discover-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('resolveAppFile', () => {
  it('honors --app when explicit', async () => {
    const explicit = path.join(workDir, 'custom-app.ts');
    await writeFile(explicit, BUILDER_SOURCE);
    const resolved = await resolveAppFile({ cwd: workDir, appPath: 'custom-app.ts' });
    expect(resolved).toBe(explicit);
  });

  it('picks dot.config.ts first when present', async () => {
    await writeFile(path.join(workDir, 'dot.config.ts'), BUILDER_SOURCE);
    await mkdir(path.join(workDir, 'src'), { recursive: true });
    await writeFile(path.join(workDir, 'src', 'app.ts'), BUILDER_SOURCE);

    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBe(path.join(workDir, 'dot.config.ts'));
  });

  it('falls back to src/app.ts when dot.config.ts is absent', async () => {
    await mkdir(path.join(workDir, 'src'), { recursive: true });
    await writeFile(path.join(workDir, 'src', 'app.ts'), BUILDER_SOURCE);

    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBe(path.join(workDir, 'src', 'app.ts'));
  });

  it('falls back to ./app.ts when neither dot.config.ts nor src/app.ts exist', async () => {
    await writeFile(path.join(workDir, 'app.ts'), BUILDER_SOURCE);

    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBe(path.join(workDir, 'app.ts'));
  });

  it('returns null when no app file is discovered', async () => {
    const resolved = await resolveAppFile({ cwd: workDir });
    expect(resolved).toBeNull();
  });
});

describe('loadAppFromFile', () => {
  it('loads a DotAppBuilder default export', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(file, BUILDER_SOURCE);
    const app = await loadAppFromFile(file);
    // DotAppBuilder duck-typing: `use` + `configure` + `boot` all functions.
    expect(typeof (app as { use?: unknown }).use).toBe('function');
    expect(typeof (app as { configure?: unknown }).configure).toBe('function');
    expect(typeof (app as { boot?: unknown }).boot).toBe('function');
  });

  it('loads a default-export factory function and awaits its return', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(file, FACTORY_SOURCE);
    const app = await loadAppFromFile(file);
    expect(typeof (app as { use?: unknown }).use).toBe('function');
  });

  it('finds a named `app` export, because apps export `app` by name and `dot explain --app <file>` must work on them', async () => {
    const file = path.join(workDir, 'app.server.ts');
    await writeFile(file, appSource("export const app = defineApp('named').use(p);"));
    const app = await loadAppFromFile(file);
    expect(typeof (app as { use?: unknown }).use).toBe('function');
  });

  it('lets the default export win over `app`, so existing default-export apps keep their meaning', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(
      file,
      appSource(
        "export const app = defineApp('named').use(p);\nexport default Object.assign(defineApp('wins').use(p), { marker: 'default' });",
      ),
    );
    const app = await loadAppFromFile(file);
    expect(app).toMatchObject({ marker: 'default' });
  });

  it('finds the one DOT app under another name, because a file with a single app is not ambiguous', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(file, appSource("export const helper = 1;\nexport const server = defineApp('other').use(p);"));
    const app = await loadAppFromFile(file);
    expect(typeof (app as { use?: unknown }).use).toBe('function');
  });

  it('lists both names when two DOT apps are exported without default/app, so the developer knows what to rename', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(
      file,
      appSource("export const one = defineApp('one').use(p);\nexport const two = defineApp('two').use(p);"),
    );
    await expect(loadAppFromFile(file)).resolves.toMatchObject({
      code: AppInvalidExport.code,
      message: expect.stringMatching(/one, two/),
      remediation: expect.stringContaining('`default` or as `app`'),
    });
  });

  it('returns the coded failure listing the exports when the file has no DOT app, so the failure names what was found', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(file, 'export const config = { a: 1 };\n');
    await expect(loadAppFromFile(file)).resolves.toMatchObject({
      code: AppInvalidExport.code,
      message: expect.stringContaining('config'),
    });
  });

  it('returns dot.app_invalid_export when default export is not a DotApp', async () => {
    const file = path.join(workDir, 'app.ts');
    await writeFile(file, BAD_EXPORT_SOURCE);
    await expect(loadAppFromFile(file)).resolves.toMatchObject({
      code: AppInvalidExport.code,
    });
  });

  it('surfaces the code and fix of a declaration that rejected a mistake at import', async () => {
    // Declarations throw a coded error for a mistake in the code. The import
    // fails, and the developer needs that code and its fix, not only "import failed".
    const file = path.join(workDir, 'app.ts');
    await writeFile(
      file,
      `const error = Object.assign(new Error('[feature] router mount key "orders" is contributed by more than one feature.'), {
  code: 'ARKI_DOT_E022',
  remediation: 'Give each feature its own router mount key.',
});
throw error;
`,
    );
    await expect(loadAppFromFile(file)).resolves.toMatchObject({
      code: AppImportFailed.code,
      message: expect.stringContaining('[ARKI_DOT_E022] [feature] router mount key "orders"'),
      data: {
        filePath: file,
        causeCode: 'ARKI_DOT_E022',
        causeRemediation: 'Give each feature its own router mount key.',
      },
    });
  });
});

/** The discovery result, or a thrown error naming the failure: these cases expect an app. */
function found(result: DiscoveryResult | Awaited<ReturnType<typeof discoverApp>>): DiscoveryResult {
  if (isFailure(result)) throw new Error(`expected an app, got ${result.code}: ${result.message}`);
  return result;
}

describe('discoverApp', () => {
  it('default discovery: dot.config.ts at cwd is loaded', async () => {
    await writeFile(path.join(workDir, 'dot.config.ts'), BUILDER_SOURCE);
    const result = found(await discoverApp({ cwd: workDir }));
    expect(result.filePath).toBe(path.join(workDir, 'dot.config.ts'));
    expect(typeof (result.app as { use?: unknown }).use).toBe('function');
  });

  it('default discovery: src/app.ts is loaded when dot.config.ts is missing', async () => {
    await mkdir(path.join(workDir, 'src'), { recursive: true });
    await writeFile(path.join(workDir, 'src', 'app.ts'), BUILDER_SOURCE);

    const result = found(await discoverApp({ cwd: workDir }));
    expect(result.filePath).toBe(path.join(workDir, 'src', 'app.ts'));
  });

  it('honors --app even when default candidates exist', async () => {
    await writeFile(path.join(workDir, 'dot.config.ts'), BAD_EXPORT_SOURCE);
    const explicit = path.join(workDir, 'real.ts');
    await writeFile(explicit, BUILDER_SOURCE);

    const result = found(await discoverApp({ cwd: workDir, appPath: 'real.ts' }));
    expect(result.filePath).toBe(explicit);
  });

  it('returns dot.app_not_found with what it searched when no app file is found', async () => {
    const result = await discoverApp({ cwd: workDir });
    expect(AppNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'dot.app_not_found',
      data: { cwd: workDir, searched: ['dot.config', 'src/app', 'app'] },
      remediation: expect.stringMatching(/dot\.config\.ts|--app/),
    });
  });
});
