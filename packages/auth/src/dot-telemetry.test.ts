/**
 * Auth spans nest under Dot's spans, so a trace shows which feature asked who the caller is. A
 * real Dot app boots the `auth` plugin on PGlite; a feature usecase reads the principal, and the
 * `auth.principal` span must be a child of that usecase's `feature.<feature>.<usecase>` span.
 */
import { expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';
import { captureSpans } from '@arki/testing/otel';

import type { AuthDb } from './pg/types.js';
import { authTables } from './__fixtures__/tables.js';
import { defineAuth } from './definition.js';
import { auth } from './dot.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });

it('nests auth.principal under the feature usecase that asked, so a trace shows which unit did the work', async () => {
  using spans = captureSpans();
  const { db, dispose } = await testAuth(definition, { tables: authTables });
  try {
    const providers = infra({
      name: 'providers',
      provides: {
        db: (): AuthDb => db,
        mail: () => mailer({ transport: mailSink(), from: 'Notes <auth@notes.test>' }),
      },
    });
    const authn = auth(definition, {
      tables: authTables,
      rateLimit: false,
      runtime: () => ({
        url: 'http://localhost:3000',
        secret: 'dot-telemetry-secret-0123456789abcdef',
        production: false,
      }),
    });
    const notes = defineFeature('notes')
      .needs({ auth: authn.provides.auth })
      .usecases({
        whoAmI:
          ({ auth: service }) =>
          (headers: Headers) =>
            service.principal(headers),
      })
      .entrypoints();
    const app = orThrow(await defineApp('notes').infra(providers).infra(authn).features([notes]).start());
    try {
      const { headers } = await actingAs(app.services.auth, { email: 'ada@notes.test' });
      spans.reset();

      await expect(app.services['notes.usecases'].whoAmI(headers)).resolves.toMatchObject({
        user: { email: 'ada@notes.test' },
      });

      const principal = spans.named('auth.principal');
      expect(principal.parent?.name).toBe('feature.notes.whoAmI');
      expect(principal.instrumentationScope.name).toBe('@arki/auth');
      // Credentials and identities stay out of the span: no cookie, no email, no user id.
      expect(JSON.stringify(principal.attributes)).not.toMatch(/ada@notes\.test|cookie|session/i);
    } finally {
      orThrow(await app.dispose());
    }
  } finally {
    await dispose();
  }
});
