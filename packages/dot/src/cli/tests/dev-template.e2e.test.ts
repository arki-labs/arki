/**
 * The plan's Milestone 1 demo as a test: a fresh `dot new` app passes
 * `dot dev --once` — env validated, the committed `drizzle/` migration
 * applied to the embedded PGlite database, the app booted — and exits 0. A
 * second run finds nothing pending, which proves the first run really
 * migrated the data directory and gave it back (the owner lock).
 *
 * The app is scaffolded inside the repo (`.cache/`, git-ignored) so its
 * imports resolve to the workspace packages, built in `dist/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runNew } from '../new.js';

const CLI = path.resolve(__dirname, '..', 'index.ts');
const ROOT = path.resolve(__dirname, '..', '..', '..', '.cache', 'dev-template-e2e');
const APP = path.join(ROOT, 'shop');

const envelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ items: z.array(z.looseObject({ kind: z.string() })) }),
});

/** `dot dev --once` in the app, with no database URL anywhere in the environment. */
function devOnce() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'DB_URL' && key !== 'DATABASE_URL'),
  );
  const run = spawnSync('bun', ['--bun', CLI, 'dev', '--once', '--db', 'pglite', '--output', 'json'], {
    cwd: APP,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const scaffolded = await runNew({ name: 'shop', cwd: ROOT });
  expect('app' in scaffolded).toBe(true);
}, 60_000);

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('dot dev --once on a fresh dot new app', () => {
  it('applies the committed migration, boots, exits 0; a second run has nothing pending', () => {
    const first = devOnce();
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const items = envelopeSchema.parse(JSON.parse(first.stdout)).data.items;
    expect(items.map(item => item.kind)).toEqual(['app', 'db', 'migrations', 'preflight']);
    expect(items[0]).toMatchObject({ exportName: 'dev' });
    expect(items[2]).toEqual({ kind: 'migrations', pending: ['20261014000000_init'] });
    expect(items[3]).toMatchObject({ kind: 'preflight', status: 'ok' });

    const second = devOnce();
    expect(second.status).toBe(0);
    expect(envelopeSchema.parse(JSON.parse(second.stdout)).data.items[2]).toEqual({ kind: 'migrations', pending: [] });
  }, 240_000);
});
