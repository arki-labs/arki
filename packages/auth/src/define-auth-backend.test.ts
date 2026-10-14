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
