/** Managed CLI boundaries must report returned failures and exit unsuccessfully. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineFailure } from '@arki/failure';

import { defineApp } from '../../define-app.js';
import { plugin } from '../../plugin-contract.js';
import { discoverApp } from '../discover.js';
import { runDoctor } from '../doctor.js';
import { runExplain } from '../explain.js';
import { program } from '../index.js';
import { runPreflightChild } from '../preflight-child.js';
import { runServe } from '../serve.js';

const Refused = defineFailure('test.cli_lifecycle.refused');
const DEFINE_APP_PATH = path.resolve(__dirname, '../../define-app.ts');
const PLUGIN_PATH = path.resolve(__dirname, '../../plugin-contract.ts');
const FAILURE_PATH = path.resolve(__dirname, '../../../../failure/src/index.ts');
const imports = `
import { defineApp } from ${JSON.stringify(DEFINE_APP_PATH)};
import { plugin } from ${JSON.stringify(PLUGIN_PATH)};
import { defineFailure } from ${JSON.stringify(FAILURE_PATH)};
const Refused = defineFailure('test.cli_lifecycle.refused');
`;
let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dot-cli-lifecycle-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function appFile(body: string) {
  const file = path.join(workDir, 'app.ts');
  await writeFile(file, `${imports}\n${body}\n`);
  return file;
}

async function dot(argv: string[]) {
  let stdout = '';
  const code = await program.main([...argv, '--json'], {
    stdout: value => {
      stdout += value;
    },
  });
  const envelope: unknown = JSON.parse(stdout);
  return { code, envelope };
}

describe('managed lifecycle failures', () => {
  it('returns configure failures before explain or doctor reads app state', async () => {
    const failure = Refused();
    const make = () => defineApp('configure-refusal').use(plugin({ name: 'refused', configure: () => failure }));
    expect(await runExplain(make())).toBe(failure);
    expect(await runDoctor(make())).toBe(failure);
  });

  it.each(['explain', 'doctor'])('%s exits nonzero for a returned configure failure', async command => {
    const file = await appFile(
      "export default defineApp('configure-refusal').use(plugin({ name: 'refused', configure: () => Refused() }));",
    );
    const result = await dot([command, '--app', file]);
    expect(result.code).toBe(3);
    expect(result.envelope).toMatchObject({ ok: false, error: { code: Refused.code } });
  });

  it('preflight retains configure failure data and exits nonzero', async () => {
    const file = await appFile(
      "export const dev = defineApp('configure-refusal').use(plugin({ name: 'refused', configure: () => Refused() }));",
    );
    expect(await runPreflightChild({ app: file })).toMatchObject({
      app: null,
      report: null,
      failure: { code: Refused.code },
    });
    const result = await dot(['_preflight', '--app', file]);
    expect(result.code).toBe(3);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { code: 'dot.preflight_failed', data: { failure: { code: Refused.code } } },
    });
  });

  it('doctor and preflight report disposal failure instead of a passing boot', async () => {
    const file = await appFile(
      "export default defineApp('dispose-refusal').use(plugin({ name: 'refused', dispose: () => Refused() }));",
    );
    const doctor = await dot(['doctor', '--app', file]);
    expect(doctor.code).toBe(3);
    expect(doctor.envelope).toMatchObject({ ok: false, error: { code: Refused.code } });
    const preflight = await dot(['_preflight', '--app', file]);
    expect(preflight.code).toBe(3);
    expect(preflight.envelope).toMatchObject({
      ok: false,
      error: { code: 'dot.preflight_failed', data: { app: { plugins: 1 }, failure: { code: Refused.code } } },
    });
  });

  it.each(['stop', 'dispose'])('serve returns a resolved %s failure during shutdown', async phase => {
    const file = await appFile(
      `export const dev = defineApp('shutdown-refusal').use(plugin({ name: 'refused', ${phase}: () => Refused() }));`,
    );
    const result = await runServe({ app: file, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ code: Refused.code });
  });

  it('supervises module evaluation defects and preserves declaration codes', async () => {
    const file = await appFile(
      "throw Object.assign(new Error('invalid declaration'), { code: 'ARKI_DOT_E020', remediation: 'Mount the provider first.' });",
    );
    const result = await dot(['explain', '--app', file]);
    expect(result.code).toBe(3);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: 'dot.app_import_failed',
        data: { causeCode: 'ARKI_DOT_E020', causeRemediation: 'Mount the provider first.' },
      },
    });
  });

  it('preserves failures returned by a managed app factory', async () => {
    const file = await appFile('export default () => Refused();');
    expect(await discoverApp({ appPath: file })).toMatchObject({ code: Refused.code });
  });

  it('retains code metadata for failures thrown during module evaluation', async () => {
    const file = await appFile('throw Refused();');
    expect(await discoverApp({ appPath: file })).toMatchObject({
      code: 'dot.app_import_failed',
      data: { causeCode: Refused.code },
    });
  });
});
