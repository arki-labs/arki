/**
 * A feature-owned schedule handler is an entrypoint, so it receives what Dot's entrypoints receive:
 * the feature's `entrypointOnly(...)` needs and `usecases`, at any builder stage.
 *
 * Why this exists: before `.usecases()`, Dot's `DepsOf` is what a usecase may ask for (plain needs,
 * infra), not what an entrypoint gets. A handler typed with it on a feature with no usecases would
 * lose its entrypoint-only `db` and be offered a `mailer` the runtime never passes.
 */
import { expectTypeOf } from 'vitest';

import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';

import { schedules } from './dot.js';

type Db = { readonly ping: () => boolean };
type Mailer = { readonly send: (to: string) => boolean };

const database = infra({ name: 'database', provides: { db: (): Db => ({ ping: () => true }) } });
const mail = infra({ name: 'mail', provides: { mailer: (): Mailer => ({ send: to => to.length > 0 }) } });

const probeDeps = defineFeature('probe').needs({
  db: entrypointOnly(database.provides.db),
  mailer: mail.provides.mailer,
});

probeDeps.entrypoints(
  schedules(probeDeps, [
    {
      name: 'ping-db',
      every: '1m',
      handler: services => {
        expectTypeOf(services.db).toEqualTypeOf<Db>();
        return services.db.ping();
      },
    },
  ]),
);

schedules(probeDeps, [
  {
    name: 'mail',
    every: '1m',
    // @ts-expect-error -- `mailer` is a plain need: it reaches usecases, never an entrypoint
    handler: ({ mailer }) => mailer.send('ops'),
  },
]);
