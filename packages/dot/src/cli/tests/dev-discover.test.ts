/**
 * `prefer: 'dev'` exists so `dot dev` runs the app wired for development
 * (the `dev` export) while `dot doctor` and `dot explain` keep reading the
 * default one. A `dev` export that is not an unstarted builder must not win:
 * `dot dev` has to own its lifecycle.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { discoverApp, guards } from '../discover.js';
import { tempProject } from './dev-helpers.js';

const DEFINE_APP_PATH = path.resolve(__dirname, '..', '..', 'define-app.ts');
const PLUGIN_CONTRACT_PATH = path.resolve(__dirname, '..', '..', 'plugin-contract.ts');

const source = (exports: string): string => `
import { defineApp } from '${DEFINE_APP_PATH}';
import { plugin } from '${PLUGIN_CONTRACT_PATH}';
const p = plugin({ name: 'p', boot: () => ({}) });
${exports}
`;

let workDir: string;

beforeEach(async () => {
  workDir = await tempProject('dot-dev-discover-');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function discover(exports: string, prefer?: 'default' | 'dev') {
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, 'dot.config.ts'), source(exports));
  const result = await discoverApp({ cwd: workDir, ...(prefer === undefined ? {} : { prefer }) });
  if (isFailure(result)) throw new Error(result.message);
  return result;
}

describe('discoverApp prefer', () => {
  it('takes an unstarted dev builder over default when prefer is dev', async () => {
    const result = await discover(
      `export const dev = defineApp('dev-app').use(p);\nexport default defineApp('prod-app').use(p);`,
      'dev',
    );
    expect(result.exportName).toBe('dev');
    expect(guards.isDotAppBuilder(result.app) && result.app.configure().manifest.app.name).toBe('dev-app');
  });

  it('keeps the default export without prefer, even when a dev export exists', async () => {
    const result = await discover(
      `export const dev = defineApp('dev-app').use(p);\nexport default defineApp('prod-app').use(p);`,
    );
    expect(result.exportName).toBe('default');
  });

  it('falls back to the usual order when the dev export is already configured', async () => {
    const result = await discover(
      `export const dev = defineApp('dev-app').use(p).configure();\nexport const app = defineApp('prod-app').use(p);`,
      'dev',
    );
    expect(result.exportName).toBe('app');
  });

  it('uses the default export under prefer dev when there is no dev export', async () => {
    const result = await discover(`export default defineApp('prod-app').use(p);`, 'dev');
    expect(result.exportName).toBe('default');
  });
});
