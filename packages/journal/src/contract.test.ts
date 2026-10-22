import { expect, it } from 'vitest';

import { buildSync } from 'esbuild';

/** Server-only code a contract must never pull into a browser bundle. */
const SERVER_ONLY = ['drizzle-orm', 'node_modules/pg/', 'node_modules/postgres/'];

// An oRPC contract ships to the browser. `COMMAND_FAILURES` once came from `@arki/db/transaction`, which
// imports Drizzle, so every client bundle that listed the journal's failures carried the ORM.
it('the contract entry bundles for the browser without Drizzle or a Postgres driver', () => {
  const result = buildSync({
    entryPoints: [new URL('contract.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.filter(input => SERVER_ONLY.some(fragment => input.includes(fragment)))).toEqual([]);
});
