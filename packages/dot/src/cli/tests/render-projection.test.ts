/**
 * Tests for `dot explain --as <format>` projection rendering.
 *
 * Projection modules are adapter-owned. The kernel only selects the registered
 * format, resolves the module relative to the app file, imports `project`, and
 * prints its JSON-round-trip-safe return value.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DotAppManifest } from '../../manifest.js';
import { defineApp } from '../../define-app.js';
import { infra } from '../../unit-contract.js';
import { runExplain } from '../explain.js';
import { program } from '../index.js';
import { renderProjection } from '../render-projection.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dot-cli-projection-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function manifestOf(overrides: Partial<DotAppManifest>): DotAppManifest {
  return {
    manifestVersion: 2,
    app: { name: 'shop-api', version: '1.0.0' },
    plugins: [],
    actions: [],
    services: [],
    dependencies: [],
    lifecycle: [],
    projections: [],
    ...overrides,
  };
}

/** Run `dot` with argv; return the exit code and the parsed JSON envelope. */
async function dot(argv: string[]): Promise<{ code: number; envelope: { error: { code: string; message: string } } }> {
  let stdout = '';
  const code = await program.main([...argv, '--json'], {
    stdout: text => {
      stdout += text;
    },
  });
  return { code, envelope: JSON.parse(stdout) as { error: { code: string; message: string } } };
}

describe('--as flag rules', () => {
  it('rejects --as with --graph, --module without --as, and --as on doctor: exit 2, cli.invalid_input', async () => {
    const both = await dot(['explain', '--as', 'openapi', '--graph']);
    expect(both.code).toBe(2);
    expect(both.envelope.error).toMatchObject({
      code: 'cli.invalid_input',
      message: expect.stringContaining('--graph'),
    });

    const moduleOnly = await dot(['explain', '--module', './projection.ts']);
    expect(moduleOnly.code).toBe(2);
    expect(moduleOnly.envelope.error.message).toContain('--module needs --as');

    const onDoctor = await dot(['doctor', '--as', 'openapi']);
    expect(onDoctor.code).toBe(2);
    expect(onDoctor.envelope.error.code).toBe('cli.invalid_input');
  });

  it('--openapi is gone: it was a deprecated alias for --as openapi', async () => {
    const result = await dot(['explain', '--openapi']);
    expect(result.code).toBe(2);
    expect(result.envelope.error.code).toBe('cli.invalid_input');
  });
});

describe('renderProjection', () => {
  it('returns dot.projection_not_found when the requested format is not registered', async () => {
    const appFilePath = path.join(workDir, 'app.ts');
    await writeFile(appFilePath, '');

    await expect(renderProjection({ manifest: manifestOf({}), format: 'openapi', appFilePath })).resolves.toMatchObject(
      {
        code: 'dot.projection_not_found',
        data: { format: 'openapi', registeredFormats: [] },
      },
    );
  });

  it('returns dot.projection_conflict for conflicting projection modules in the same format', async () => {
    const appFilePath = path.join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    const manifest = manifestOf({
      projections: [
        { format: 'openapi', binding: 'http', module: './a.ts', plugin: 'a' },
        { format: 'openapi', binding: 'http', module: './b.ts', plugin: 'b' },
      ],
    });

    await expect(renderProjection({ manifest, format: 'openapi', appFilePath })).resolves.toMatchObject({
      code: 'dot.projection_conflict',
    });
  });

  it('resolves projection modules relative to the app file and returns the document', async () => {
    const appFilePath = path.join(workDir, 'nested', 'app.ts');
    await mkdir(path.join(workDir, 'nested'), { recursive: true });
    await writeFile(appFilePath, '');
    await writeFile(
      path.join(workDir, 'nested', 'projection.ts'),
      `
export function project(manifest) {
  return { title: manifest.app.name, actionCount: manifest.actions.length };
}
`,
    );

    const manifest = manifestOf({
      actions: [{ id: 'health', plugin: 'api', binding: 'http', direction: 'in', address: 'GET /health' }],
      projections: [{ format: 'custom:doc', binding: 'http', module: './projection.ts', plugin: 'api' }],
    });

    const projected = await renderProjection({ manifest, format: 'custom:doc', appFilePath });

    expect(projected).toEqual({ format: 'custom:doc', document: { title: 'shop-api', actionCount: 1 } });
  });

  // Why: a projection's JSON document is for tools, its text is for a reader. `render(document)` lets the
  // adapter print a reading view without a second document format, and the projection's own `meta` carries
  // data no action holds (the journal's folds and inline projections).
  it("adds the module's render(document) as text, and hands the projection's meta to project()", async () => {
    const appFilePath = path.join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    await writeFile(
      path.join(workDir, 'flow.ts'),
      `
export function project(manifest) {
  return { events: manifest.projections[0].meta.events };
}
export function render(document) {
  return document.events.join('\\n');
}
`,
    );
    const manifest = manifestOf({
      projections: [
        { format: 'flow', binding: 'journal', module: './flow.ts', plugin: 'journal', meta: { events: ['A', 'B'] } },
      ],
    });

    const projected = await renderProjection({ manifest, format: 'flow', appFilePath });

    expect(projected).toEqual({ format: 'flow', document: { events: ['A', 'B'] }, text: 'A\nB' });
  });

  it("adds the module's consolePage(document) as page only when asked, and fails when the module has none", async () => {
    const appFilePath = path.join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    await writeFile(
      path.join(workDir, 'paged.ts'),
      `
export function project() {
  return { events: ['A'] };
}
export function consolePage(document) {
  return '<p>' + document.events.join(',') + '</p>';
}
`,
    );
    await writeFile(path.join(workDir, 'plain.ts'), 'export function project() { return {}; }\n');
    const manifest = manifestOf({
      projections: [
        { format: 'paged', binding: 'x', module: './paged.ts', plugin: 'x', console: { title: 'Paged' } },
        { format: 'plain', binding: 'x', module: './plain.ts', plugin: 'x' },
      ],
    });

    expect(await renderProjection({ manifest, format: 'paged', appFilePath })).toEqual({
      format: 'paged',
      document: { events: ['A'] },
    });
    expect(await renderProjection({ manifest, format: 'paged', appFilePath, page: true })).toEqual({
      format: 'paged',
      document: { events: ['A'] },
      page: '<p>A</p>',
    });
    const refused = await renderProjection({ manifest, format: 'plain', appFilePath, page: true });
    expect(refused).toMatchObject({ code: 'dot.projection_execution_failed' });
  });

  it('refuses a render(document) that returns no string, so the CLI never prints a non-string', async () => {
    const appFilePath = path.join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    await writeFile(
      path.join(workDir, 'bad-render.ts'),
      `
export function project() {
  return {};
}
export function render() {
  return 42;
}
`,
    );
    const manifest = manifestOf({
      projections: [{ format: 'bad', binding: 'x', module: './bad-render.ts', plugin: 'x' }],
    });

    const projected = await renderProjection({ manifest, format: 'bad', appFilePath });

    expect(projected).toMatchObject({ code: 'dot.projection_execution_failed' });
  });
});

describe('runExplain projection flow', () => {
  it('uses --module as a per-invocation projection override', async () => {
    const appFilePath = path.join(workDir, 'app.ts');
    await writeFile(appFilePath, '');
    await writeFile(
      path.join(workDir, 'override.ts'),
      `
export function project(manifest) {
  return 'override:' + manifest.app.name;
}
`,
    );

    const api = infra({
      name: 'api',
      configure: ctx => {
        ctx.registerProjection({ format: 'help-text', binding: 'cli', module: './missing.ts' });
      },
    });
    const builder = defineApp('cli-app').infra(api);

    const projected = await runExplain(builder, { as: 'help-text', module: './override.ts', appFilePath });

    expect(projected).toEqual({ format: 'help-text', document: 'override:cli-app' });
  });
});
