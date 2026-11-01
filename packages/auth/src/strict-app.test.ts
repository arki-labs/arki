/**
 * The public React and TanStack Start types fit an app compiled with `exactOptionalPropertyTypes`.
 *
 * The package itself compiles without that flag, so its own type check cannot see these failures.
 * Each case compiles a small strict app with `tsc` and expects no error. Both failed once in the
 * drop-studio demo (lib gaps #30 and #31): the app had to cast the auth client, and its sign-in
 * guard could not send the user back with a typed `search`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const workRoot = fileURLToPath(new URL('../.cache/strict-app/', import.meta.url));
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

/** Compiles `consumer` in `dir` as a strict app and returns the `tsc` errors. */
function compileStrictApp(dir: string, consumer: string): readonly string[] {
  writeFileSync(path.join(dir, 'consumer.ts'), consumer);
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: '../../../tsconfig.json',
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        noEmit: true,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        rootDir: '../../..',
      },
      include: [],
      files: ['consumer.ts'],
    }),
  );
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  return `${result.stdout}\n${result.stderr}`.split('\n').filter(line => line.includes('error TS'));
}

/** A fresh work folder for one case. */
function workDir(name: string): string {
  const dir = path.join(workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Copies the type files of an installed package (and its nested packages) into `target`. */
function copyTypes(source: string, target: string): void {
  for (const entry of readdirSync(source)) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    if (statSync(from).isDirectory()) copyTypes(from, to);
    else if (entry === 'package.json' || entry.endsWith('.d.ts')) {
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
    }
  }
}

/**
 * A second install of TanStack Router next to the app, with another version, like an app that
 * links this package from a checkout (or pins another patch release): the package's types then
 * come from one copy and the app's `redirect()` from the other. `tsc` merges two copies only
 * when name and version match, so the copy gets its own version.
 */
function installRouterCopy(dir: string): void {
  for (const name of ['@tanstack/react-router', '@tanstack/history']) {
    const source = path.dirname(require.resolve(`${name}/package.json`));
    copyTypes(source, path.join(dir, 'node_modules', name));
  }
  const pending = [path.join(dir, 'node_modules')];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of readdirSync(next)) {
      const file = path.join(next, entry);
      if (statSync(file).isDirectory()) pending.push(file);
      else if (entry === 'package.json') {
        writeFileSync(file, readFileSync(file, 'utf8').replace(/"version": "([^"]+)"/, '"version": "$1-app-copy"'));
      }
    }
  }
}

describe('a strict app (exactOptionalPropertyTypes)', () => {
  it('passes the engine client from `createAuthClient` to `createSignInHandlers` without a cast', () => {
    // WHY: the form's adapter once declared its own result type (`code: string | null`) and the
    // engine client returns `code?: string | undefined`, so the documented wiring did not compile.
    const dir = workDir('sign-in-handlers');
    const errors = compileStrictApp(
      dir,
      `
import { defineAuth } from '../../../src/definition.js';
import { createAuthClient } from '../../../src/react/client.js';
import { createSignInHandlers } from '../../../src/react/sign-in-form.js';

const definition = defineAuth({ app: { name: 'Shop', key: 'shop' }, methods: ['password', 'magicLink', 'google'] });
export const handlers = createSignInHandlers(createAuthClient(definition), { redirectTo: '/' });
`,
    );
    expect(errors).toEqual([]);
  });

  it('accepts a typed `redirect({ to, search })` from the app router in `createRequireAuth`', { timeout: 60_000 }, () => {
    // WHY: a guard sends a guest to sign-in and back again, which needs a typed `search`. Typed as
    // `AnyRedirect`, the callback refused the app's redirect when the router types came from
    // another install, and the app fell back to an untyped `href`.
    const dir = workDir('require-auth');
    installRouterCopy(dir);
    const errors = compileStrictApp(
      dir,
      `
import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';

import { createRequireAuth } from '../../../src/tanstack-start/require-auth.js';

const rootRoute = createRootRoute();
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): { redirect?: string | undefined } =>
    typeof search['redirect'] === 'string' ? { redirect: search['redirect'] } : {},
});
const router = createRouter({ routeTree: rootRoute.addChildren([signInRoute]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const noSession = () => Promise.resolve(null);

export const requireAuth = createRequireAuth(noSession, () =>
  redirect({ to: '/sign-in', search: { redirect: '/studio' } }),
);

// @ts-expect-error -- the guard still takes only a router redirect.
export const notARedirect = createRequireAuth(noSession, () => new Response());
`,
    );
    expect(errors).toEqual([]);
  });
});
