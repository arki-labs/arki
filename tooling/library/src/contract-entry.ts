/**
 * CONTRACT_E001: the `./contract` entry pulls server-only code into a browser bundle.
 *
 * `./contract` is the one browser-safe entry a library offers to oRPC contracts
 * that ship to the browser: the failures a contract lists in its error map, and
 * the ids and schemas it uses for input and output. A library whose root entry
 * is browser-safe needs no `./contract`. The check bundles the entry for the
 * browser with esbuild and fails on a build error (a Node built-in the browser
 * cannot resolve) or on a bundled server-only package.
 *
 * CONTRACT_E002: an entry named `./contracts`. The browser-safe contract entry
 * has one name, `./contract`; the plural belongs to the `@arki/contracts` package.
 *
 * CONTRACT_W001: the entry's file does not exist yet (a `dist/` entry before
 * `build`), so the bundle check is skipped with a warning.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

import type { CheckResult } from './library-check';
import type { Manifest } from './manifest';
import { runtimeEntry } from './manifest';

/**
 * Server-only packages that can bundle without touching a Node built-in, so a
 * build error alone would miss them. A contract carries failures, ids and
 * schemas: never a queue client, a database driver, an ORM or an auth server.
 */
const SERVER_ONLY = ['bullmq', 'ioredis', 'node_modules/pg/', 'node_modules/postgres/', 'drizzle-orm', 'better-auth'];

/** The first lines of an esbuild failure: enough to name the import that broke. */
const FAILURE_LINES = 3;

/** Bundles `file` for the browser; returns every bundled input, or why the build failed. */
function browserBundle(dir: string, file: string): { inputs: string[] } | { failure: string } {
  try {
    const result = buildSync({
      entryPoints: [file],
      absWorkingDir: path.resolve(dir),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    return { inputs: Object.keys(result.metafile.inputs) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: message.split('\n').filter(Boolean).slice(0, FAILURE_LINES).join(' | ') };
  }
}

export function checkContractEntry(dir: string, manifest: Manifest): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if ('./contracts' in manifest.exports) {
    errors.push('CONTRACT_E002 export "./contracts": the browser-safe contract entry is "./contract"');
  }

  const target = manifest.exports['./contract'];
  if (target === undefined) return { errors, warnings };

  const entry = runtimeEntry(target);
  if (entry === undefined) {
    errors.push('CONTRACT_E001 export "./contract" has no "import" or "default" file to bundle');
    return { errors, warnings };
  }
  if (!existsSync(path.join(dir, entry))) {
    warnings.push(`CONTRACT_W001 export "./contract" not built (${entry}): browser bundle check skipped`);
    return { errors, warnings };
  }

  const bundled = browserBundle(dir, entry);
  if ('failure' in bundled) {
    errors.push(`CONTRACT_E001 export "./contract" does not bundle for the browser: ${bundled.failure}`);
    return { errors, warnings };
  }
  const leaks = bundled.inputs.filter(input => SERVER_ONLY.some(fragment => input.includes(fragment)));
  if (leaks.length > 0) {
    const names = [...new Set(leaks.map(input => SERVER_ONLY.find(fragment => input.includes(fragment))))];
    errors.push(`CONTRACT_E001 export "./contract" bundles server-only code: ${names.join(', ')}`);
  }
  return { errors, warnings };
}
