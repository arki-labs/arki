import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { pip, type EmptyShape } from '@arki/dot/pip';

import { initAuth } from './better-auth.config.js';
import { auth, type AuthDb } from './dot.js';
import { initAuth as legacyInitAuth } from './dot.config.js';

const dbProvider = pip<EmptyShape, { readonly db: AuthDb }>({
  name: 'db',
  configure(ctx) {
    ctx.registerService('db', 'db');
  },
  boot() {
    throw new Error('auth DOT manifest tests should not boot the database provider');
  },
});

describe('auth DOT pip', () => {
  it('declares a db need and publishes the auth service', () => {
    const app = defineApp('auth-app')
      .use(dbProvider)
      .use(
        auth({
          appName: 'Auth App',
          appKey: 'auth-app',
          baseUrl: 'http://localhost:3000',
        }),
      )
      .configure();

    expect(app.manifest.services).toContainEqual({ name: 'db', pip: 'db', kind: 'db' });
    expect(app.manifest.services).toContainEqual({ name: 'auth', pip: 'auth', kind: 'auth' });
    expect(app.manifest.actions).toEqual([]);
  });

  it('keeps the legacy dot.config initAuth export as a compatibility shim', () => {
    expect(legacyInitAuth).toBe(initAuth);
  });
});
