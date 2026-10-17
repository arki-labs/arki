import { describe, expect, it } from 'vitest';

import { initDbRuntimeLocal } from '@arki/db/runtime-local';

import { defineAuthBackend } from './define-auth-backend';

const { db } = await initDbRuntimeLocal({ memory: true }, { relations: {} });

describe('defineAuthBackend magic link', () => {
  // The verification table holds live sign-in tokens for five minutes. Stored raw, a database
  // read (backup, replica, SQL injection elsewhere) is enough to sign in as any pending user.
  it('stores magic-link tokens hashed, not in plain text', () => {
    const auth = defineAuthBackend({
      db,
      schema: { user: {}, account: {}, session: {}, verification: {} },
      appName: 'fixture',
      appKey: 'fixture',
      baseUrl: 'http://localhost',
      productionUrl: 'http://localhost',
      secret: 'fixture-secret-at-least-32-characters-long',
      magicLink: { send: () => Promise.resolve() },
    });

    const plugin = auth.options.plugins.find(p => p.id === 'magic-link');

    expect(plugin?.options?.['storeToken']).toBe('hashed');
  });
});

describe('defineAuthBackend default ids', () => {
  const auth = defineAuthBackend({
    db,
    schema: { user: {}, account: {}, session: {}, verification: {} },
    appName: 'fixture',
    appKey: 'fixture',
    baseUrl: 'http://localhost',
    productionUrl: 'http://localhost',
    secret: 'fixture-secret-at-least-32-characters-long',
  });
  const generateId = auth.options.advanced.database.generateId;

  // `UserId` (`@arki/contracts`) is `usr_…`. A user stored under any other prefix fails every
  // `userIdSchema` check downstream, so the engine must store the same prefix.
  it('gives users a usr_ id, the shared UserId', () => {
    if (typeof generateId !== 'function') throw new Error('expected a generateId hook');
    expect(generateId({ model: 'user' })).toMatch(/^usr_[a-z0-9]+$/);
    expect(generateId({ model: 'users' })).toMatch(/^usr_/);
  });

  it('keeps <model>_<hex> for every other model', () => {
    if (typeof generateId !== 'function') throw new Error('expected a generateId hook');
    expect(generateId({ model: 'session' })).toMatch(/^session_[0-9a-f]{32}$/);
    expect(generateId({ model: 'organization' })).toMatch(/^organization_[0-9a-f]{32}$/);
  });
});
