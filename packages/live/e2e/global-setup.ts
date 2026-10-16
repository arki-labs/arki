/**
 * Once per run: one Postgres container (it outlives every app restart a spec
 * makes), the `posts` table and its live triggers, and one production build
 * of the fixture app. `DATABASE_URL` reaches the workers and the app server
 * through `process.env`. The returned function is the teardown.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { liveTables } from '@arki/live';
import { liveMigration } from '@arki/live/pg';

import { CREATE_POSTS_SQL, LIVE_APP_NAME, liveAppManifest } from './app/src/contract';

const appDir = fileURLToPath(new URL('app/', import.meta.url));

async function buildApp(): Promise<void> {
  const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
  const build = spawn('node', [viteBin, 'build'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  build.stdout.on('data', keep);
  build.stderr.on('data', keep);
  const [code] = await once(build, 'exit');
  if (code !== 0) throw new Error(`vite build of the e2e fixture app failed (exit ${String(code)}):\n${output}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const [container] = await Promise.all([new PostgreSqlContainer('postgres:17-alpine').start(), buildApp()]);
  const databaseUrl = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(CREATE_POSTS_SQL);
    await pool.query(liveMigration({ app: LIVE_APP_NAME, tables: liveTables(liveAppManifest) }).up);
  } finally {
    await pool.end();
  }
  process.env['DATABASE_URL'] = databaseUrl;
  return async () => {
    await container.stop();
  };
}
