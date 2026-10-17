/**
 * The auth in a Dot graph: it needs `db` and `mail` (wiring mistakes fail before boot), publishes
 * `auth`, and reads its runtime values only at boot, so the manifest never holds a secret.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EmptyShape } from '@arki/dot/plugin';
import type { Mailer } from '@arki/mail';
import { defineApp } from '@arki/dot';
import { plugin } from '@arki/dot/plugin';
import { testPlugin } from '@arki/dot/test-harness';
import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

import type { AuthOf } from './dot.js';
import type { Auth } from './pg/index.js';
import type { AuthDb } from './pg/types.js';
import { authTables } from './__fixtures__/tables.js';
import { defineAuth } from './definition.js';
import { auth } from './dot.js';
import { actingAs, testAuth } from './testing/index.js';

const SECRET = 'dot-manifest-secret-0123456789abcdef-xyz';
const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });

const providers = plugin<EmptyShape, { readonly db: AuthDb; readonly mail: Mailer }>({
  name: 'infra',
  configure(ctx) {
    ctx.registerService('db', 'db');
    ctx.registerService('mail', 'email');
  },
  boot() {
    throw new Error('manifest tests never boot the providers');
  },
});

describe('auth Dot plugin', () => {
  it('needs db and mail, publishes auth, and keeps secrets out of the manifest', () => {
    let runtimeReads = 0;
    const authn = auth(definition, {
      tables: authTables,
      rateLimit: false,
      runtime: () => {
        runtimeReads++;
        return { url: 'http://localhost:3000', secret: SECRET, production: false };
      },
    });
    const app = defineApp('notes').use(providers).use(authn).configure();

    expect(new Set(Object.keys(authn.needs))).toEqual(new Set(['db', 'mail']));
    expect(app.manifest.services).toContainEqual({ name: 'auth', plugin: 'auth', kind: 'auth' });
    expect(JSON.stringify(app.manifest)).not.toContain(SECRET);
    expect(runtimeReads).toBe(0);
  });

  it('boots on the graph db and mailer and serves sessions', async () => {
    const { db, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const app = await testPlugin(
        auth(definition, {
          tables: authTables,
          rateLimit: false,
          runtime: () => ({ url: 'http://localhost:3000', secret: SECRET, production: false }),
        }),
      )
        .provide('db', db)
        .provide('mail', mailer({ transport: mailSink(), from: 'Notes <auth@notes.test>' }))
        .boot();
      try {
        const { headers } = await actingAs(app.services.auth, { email: 'ada@notes.test' });
        await expect(app.services.auth.principal(headers)).resolves.toMatchObject({
          user: { email: 'ada@notes.test' },
        });
      } finally {
        await app.dispose();
      }
    } finally {
      await dispose();
    }
  });

  it('names the service type with AuthOf', () => {
    const authn = auth(definition, {
      tables: authTables,
      runtime: () => ({ url: 'http://localhost:3000', secret: SECRET, production: false }),
    });
    expect(authn.name).toBe('auth');
    expectTypeOf<AuthOf<typeof authn>>().toEqualTypeOf<Auth<typeof definition, typeof authTables>>();
  });
});
