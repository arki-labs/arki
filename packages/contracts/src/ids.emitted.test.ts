/**
 * A prefixed id with a generic prefix keeps its type through emitted declarations.
 *
 * A package that builds ids from a prefix its caller picks (`defineId(prefix)`
 * inside `createTombstoneTable<TPrefix>` in `@arki/ai`) gets its id type written
 * out in its `.d.ts`. When that type was Zod's own template-literal inference,
 * tsc printed it as `[TPrefix] extends $ZodTemplateLiteralPart[] ? never : never`:
 * an app reading the published types saw every such id as `never`, and the
 * declaration exposed Zod internals (`TYPES_E001`). Source-level type tests
 * cannot see this, because the bad type exists only in the emitted text. This
 * test builds the contracts declarations, a producer package against them, and
 * a consumer that sees only the producer's declarations, the way a linked app does.
 *
 * A branded id has the same risk in plain text: `defineId` used to return an anonymous
 * object, so every dependent's `.d.ts` printed `schema: z.core.$ZodBranded<...>`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const workDir = fileURLToPath(new URL('../.generated/emitted-ids/', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** The emitted contracts declarations stand in for `node_modules/@arki/contracts`. */
const emittedContracts = (prefix: string) => ({ '@arki/contracts': [`${prefix}dist/index.d.ts`] });

// Like `createTombstoneTable`: the prefix is the caller's type parameter.
const producer = `
import { defineId } from '@arki/contracts';

export function tableIds<TPrefix extends string>(prefix: TPrefix) {
  const id = defineId(prefix);
  return { prefix: id.prefix, parse: (value: unknown) => id.schema.parse(value), is: id.is };
}

export const orderId = defineId('ord_', { kind: 'shop.order' });
`;

const consumer = `
import type { IdOf } from '@arki/contracts';
import { orderId, tableIds } from './producer.js';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const ids = tableIds('vtmb_');
export const parsedIsPrefixed: Exact<ReturnType<typeof ids.parse>, \`vtmb_\${string}\`> = true;

const raw: unknown = 'vtmb_1';
export const narrowed: \`vtmb_\${string}\` | undefined = ids.is(raw) ? raw : undefined;

export const brandIsKept: Exact<IdOf<typeof orderId>, \`ord_\${string}\`> = false;
export const schemaKeepsTheBrand: Exact<ReturnType<typeof orderId.schema.parse>, IdOf<typeof orderId>> = true;
`;

function run(args: readonly string[]): { readonly status: number | null; readonly errors: readonly string[] } {
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: packageRoot, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  return { status: result.status, errors: output.split('\n').filter(line => line.includes('error TS')) };
}

function writeJson(path: string, value: object): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe('prefixed ids from emitted declarations', () => {
  it('keep a generic prefix as `${TPrefix}${string}` for the app that reads them', { timeout: 120_000 }, () => {
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(`${workDir}out`, { recursive: true });

    // 1. The contracts declarations, as `bun run build` writes them.
    const contracts = run([
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
    expect(contracts.errors).toEqual([]);
    expect(contracts.status).toBe(0);

    // 2. A producer package built against them.
    writeFileSync(`${workDir}producer.ts`, producer);
    writeJson(`${workDir}tsconfig.producer.json`, {
      extends: '../../tsconfig.json',
      compilerOptions: {
        rootDir: '.',
        outDir: './out',
        emitDeclarationOnly: true,
        declarationMap: false,
        sourceMap: false,
        paths: emittedContracts('./'),
      },
      include: [],
      files: ['producer.ts'],
    });
    const built = run(['-p', `${workDir}tsconfig.producer.json`]);
    expect(built.errors).toEqual([]);
    expect(built.status).toBe(0);

    // The producer's published id type is the plain template, with no Zod internals.
    const declaration = readFileSync(`${workDir}out/producer.d.ts`, 'utf8');
    expect(declaration).toContain('`${TPrefix}${string}`');
    expect(declaration).toContain('BrandedIdDeclaration<"ord_", "shop.order">');
    expect(declaration).not.toMatch(/\$Zod|never/);

    // 3. An app that sees only declarations gets the concrete id type, not `never`.
    writeFileSync(`${workDir}out/consumer.ts`, consumer);
    writeJson(`${workDir}out/tsconfig.json`, {
      extends: '../../../tsconfig.json',
      compilerOptions: {
        rootDir: '.',
        noEmit: true,
        emitDeclarationOnly: false,
        declaration: false,
        declarationMap: false,
        paths: emittedContracts('../'),
      },
      include: [],
      files: ['consumer.ts'],
    });
    const app = run(['-p', `${workDir}out/tsconfig.json`]);
    expect(app.errors).toEqual([]);
    expect(app.status).toBe(0);
  });
});
