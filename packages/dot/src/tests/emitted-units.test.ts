/**
 * Units that reach an app through emitted declarations still mount in an app
 * compiled with `exactOptionalPropertyTypes`.
 *
 * Packages build their `.d.ts` without that flag. When a package returns an
 * inferred unit (`log()`, `db()` from `@arki/db/dot`), tsc writes the unit's
 * type out in full, and an optional member written inline in that type is
 * printed as `boot?: Fn | undefined`. An app that turns the flag on then sees a
 * unit whose `boot` may be `undefined`, which the strict `.infra()` parameter
 * refused (TS2345 on every such unit). This test builds Dot's declarations, a
 * producer package's declarations, and a strict consumer, the way a linked app
 * sees them.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const workDir = fileURLToPath(new URL('../../.generated/emitted-units/', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** The emitted Dot declarations stand in for `node_modules/@arki/dot`. */
const emittedDot = (prefix: string) => ({
  '@arki/dot': [`${prefix}dist/index.d.ts`],
  '@arki/dot/*': [`${prefix}dist/*.d.ts`],
});

const producer = `
import { infra, service } from '@arki/dot/unit';
import { defineFailure } from '@arki/failure';

export const OpenFailed = defineFailure('fixture.open_failed', { status: 503 });
export const CloseFailed = defineFailure('fixture.close_failed', { status: 503 });

/** Like the embedded database: the factory and dispose return failures as values. */
export function store(fail: boolean) {
  return infra({
    name: 'store',
    provides: { store: async () => (fail ? OpenFailed() : { size: 0 }) },
    async dispose() {
      return fail ? CloseFailed() : undefined;
    },
  });
}

/** Like the migrations unit: needs the store and boots on it. */
export function storeCheck() {
  return infra({
    name: 'store-check',
    needs: { store: service<{ readonly size: number }>() },
    async boot({ store }) {
      await Promise.resolve(store.size);
    },
  });
}
`;

const consumer = `
import { defineApp } from '@arki/dot';
import { log } from '@arki/dot/log';
import { stdout } from '@arki/log/node';
import { store, storeCheck } from './producer.js';

export const app = defineApp('emitted-units', { version: '1' })
  .infra(log(() => ({ channels: { stdout: stdout() }, default: { level: 'info', channels: ['stdout'] } })))
  .infra(store(false))
  .infra(storeCheck());
`;

function run(args: readonly string[]): { readonly status: number | null; readonly errors: readonly string[] } {
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: packageRoot, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  return { status: result.status, errors: output.split('\n').filter(line => line.includes('error TS')) };
}

function writeJson(path: string, value: object): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe('units from emitted declarations', () => {
  it('mount in an app compiled with exactOptionalPropertyTypes', { timeout: 120_000 }, () => {
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(`${workDir}out`, { recursive: true });

    // 1. Dot's own declarations, as `bun run build` writes them.
    const dot = run([
      '-p',
      'tsconfig.build.json',
      '--emitDeclarationOnly',
      '--declarationMap',
      'false',
      '--sourceMap',
      'false',
      '--outDir',
      `${workDir}dist`,
    ]);
    expect(dot.errors).toEqual([]);
    expect(dot.status).toBe(0);

    // 2. A producer package built against them, without the flag.
    writeFileSync(`${workDir}producer.ts`, producer);
    writeJson(`${workDir}tsconfig.producer.json`, {
      extends: '../../tsconfig.json',
      compilerOptions: {
        exactOptionalPropertyTypes: false,
        rootDir: '.',
        outDir: './out',
        declarationMap: false,
        paths: emittedDot('./'),
      },
      include: [],
      files: ['producer.ts'],
    });
    const built = run(['-p', `${workDir}tsconfig.producer.json`]);
    expect(built.errors).toEqual([]);
    expect(built.status).toBe(0);

    // 3. A strict app that sees only declarations.
    writeFileSync(`${workDir}out/consumer.ts`, consumer);
    writeJson(`${workDir}out/tsconfig.json`, {
      extends: '../../../tsconfig.json',
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        noEmit: true,
        emitDeclarationOnly: false,
        declaration: false,
        declarationMap: false,
        paths: emittedDot('../'),
      },
      include: [],
      files: ['consumer.ts'],
    });
    const app = run(['-p', `${workDir}out/tsconfig.json`]);
    expect(app.errors).toEqual([]);
    expect(app.status).toBe(0);
  });
});
