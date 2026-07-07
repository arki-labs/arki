/**
 * Tests for `dot explain --as <format>` projection rendering.
 *
 * Projection modules are adapter-owned. The kernel only selects the registered
 * format, resolves the module relative to the app file, imports `project`, and
 * prints its JSON-round-trip-safe return value.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DotAppManifest } from '../../manifest.js';
import { defineApp } from '../../define-app.js';
import { pip } from '../../pip-contract.js';
import { DotCliErrorCode } from '../error-codes.js';
import { parseArgs, runExplain } from '../index.js';
import { renderProjection } from '../render-projection.js';

const FROZEN_NOW = () => new Date('2026-01-01T00:00:00.000Z');

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dot-cli-projection-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function manifestOf(overrides: Partial<DotAppManifest>): DotAppManifest {
  return {
    manifestVersion: 2,
    app: { name: 'shop-api', version: '1.0.0' },
    pips: [],
    actions: [],
    services: [],
    dependencies: [],
    lifecycle: [],
    projections: [],
    ...overrides,
  };
}

describe('--as arg parsing', () => {
  it('parses --as and --module on explain', () => {
    const parsed = parseArgs(['explain', '--as', 'openapi', '--module', './projection.ts']);
    expect(parsed.as).toBe('openapi');
    expect(parsed.module).toBe('./projection.ts');
  });

  it('keeps --openapi as a deprecated alias for --as openapi', () => {
    const parsed = parseArgs(['explain', '--openapi']);
    expect(parsed.as).toBe('openapi');
    expect(parsed.openapi).toBe(true);
  });

  it('rejects projections on doctor and graph output', () => {
    expect(() => parseArgs(['doctor', '--as', 'openapi'])).toThrow(/--as is not supported by doctor/);
    expect(() => parseArgs(['explain', '--as', 'openapi', '--graph'])).toThrow(/mutually exclusive/);
  });
});

describe('renderProjection', () => {
  it('throws DOT_CLI_E008 when the requested format is not registered', async () => {
    const appFilePath = join(workDir, 'app.ts');
    await writeFile(appFilePath, '');

    await expect(
      renderProjection(
        { manifest: manifestOf({}), command: 'explain', format: 'openapi', appFilePath },
        { json: true, now: FROZEN_NOW },
      ),
    ).rejects.toMatchObject({ code: DotCliErrorCode.ProjectionNotFound });
  });

  it('throws DOT_CLI_E011 for conflicting projection modules in the same format', async () => {
    const appFilePath = join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    const manifest = manifestOf({
      projections: [
        { format: 'openapi', binding: 'http', module: './a.ts', pip: 'a' },
        { format: 'openapi', binding: 'http', module: './b.ts', pip: 'b' },
      ],
    });

    await expect(
      renderProjection({ manifest, command: 'explain', format: 'openapi', appFilePath }, { json: true }),
    ).rejects.toMatchObject({ code: DotCliErrorCode.ProjectionConflict });
  });

  it('resolves projection modules relative to the app file and wraps JSON output', async () => {
    const appFilePath = join(workDir, 'nested', 'app.ts');
    await mkdir(join(workDir, 'nested'), { recursive: true });
    await writeFile(appFilePath, '');
    await writeFile(
      join(workDir, 'nested', 'projection.ts'),
      `
export function project(manifest) {
  return { title: manifest.app.name, actionCount: manifest.actions.length };
}
`,
    );

    const manifest = manifestOf({
      actions: [{ id: 'health', pip: 'api', binding: 'http', direction: 'in', address: 'GET /health' }],
      projections: [{ format: 'custom:doc', binding: 'http', module: './projection.ts', pip: 'api' }],
    });

    let written = '';
    const envelope = await renderProjection(
      { manifest, command: 'explain', format: 'custom:doc', appFilePath },
      { json: true, now: FROZEN_NOW, out: line => (written += line) },
    );

    expect(envelope).toMatchObject({
      status: 'success',
      command: 'explain',
      generatedAt: '2026-01-01T00:00:00.000Z',
      data: { format: 'custom:doc', document: { title: 'shop-api', actionCount: 1 } },
    });
    expect(JSON.parse(written)).toMatchObject({ data: { format: 'custom:doc' } });
  });
});

describe('runExplain projection flow', () => {
  it('uses --module as a per-invocation projection override', async () => {
    const appFilePath = join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    await writeFile(
      join(workDir, 'override.ts'),
      `
export function project(manifest) {
  return 'override:' + manifest.app.name;
}
`,
    );

    const api = pip({
      name: 'api',
      configure: ctx => {
        ctx.registerProjection({ format: 'help-text', binding: 'cli', module: './missing.ts' });
      },
    });
    const builder = defineApp('cli-app').use(api);

    let written = '';
    const envelope = await runExplain(builder, {
      json: false,
      as: 'help-text',
      module: './override.ts',
      appFilePath,
      now: FROZEN_NOW,
      out: line => (written += line),
    });

    expect(envelope).toMatchObject({ status: 'success', data: { document: 'override:cli-app' } });
    expect(written).toBe('override:cli-app\n');
  });
});
