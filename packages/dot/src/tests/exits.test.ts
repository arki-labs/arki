/**
 * The exits at runtime (RFC 2026-10-22-dot-usecase-boundary D7 and D8, plan C1 and C2).
 *
 * Why: the types stop a `provides` factory or an entrypoint from naming an
 * infra key, but a caller that skips the types (JS, a cast, an erased
 * entrypoint) must not find the key either. Otherwise a cross-feature call
 * could still bypass the usecases, and with them the tracing and supervision.
 */
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { defineFeature, domainService, entrypointOnly } from '../feature.js';
import { defineApp, infra } from '../index.js';

type Db = { readonly query: (sql: string) => number };
type Repos = { readonly byId: (id: string) => string };

const mail = infra({ name: 'mail', provides: { mailer: () => ({ send: (to: string) => to.length > 0 }) } });
const database = infra({ name: 'database', provides: { db: (): Db => ({ query: sql => sql.length }) } });
const store = infra({ name: 'store', provides: { repos: (): Repos => ({ byId: id => id }) } });
const extras = ({ repos }: { readonly repos: Repos }) => ({ label: repos.byId('x') });

/** Keys a caller could reach below the usecases: none of them may cross an exit. */
const BELOW = ['mailer', 'repos', 'extras', 'childSeen'];

describe('the exits hold no key below the usecases', () => {
  it('a provides factory gets a frozen { usecases, $-kernel keys }; entrypoints and <name>.services get db and usecases', async () => {
    let providesArg: object = {};
    let entrypointArg: object = {};
    const child = defineFeature('shop.child')
      .needs({ extras: domainService(extras) })
      .usecases({
        seen:
          ({ extras: built }) =>
          () =>
            built.label,
      })
      .provides({ childSeen: ({ usecases }) => usecases.seen })
      .entrypoints();
    const shop = defineFeature('shop')
      .needs({ mailer: mail.provides.mailer, db: entrypointOnly(database.provides.db) })
      .infra(store)
      .domainServices({ extras })
      .features(child)
      .usecases({
        find:
          ({ repos }) =>
          (id: string) =>
            repos.byId(id),
      })
      .provides({
        finder: deps => {
          providesArg = deps;
          return { find: deps.usecases.find };
        },
      })
      .entrypoints({
        kind: 'probe',
        key: 'probe',
        actions: [],
        resolve: services => {
          entrypointArg = services;
          return {};
        },
      });
    const app = orThrow(await defineApp('exits').infra(mail, database).features([shop]).start());
    try {
      expect(Object.isFrozen(providesArg)).toBe(true);
      expect(Object.keys(providesArg).filter(k => !k.startsWith('$'))).toEqual(['usecases']);
      expect(
        Object.keys(entrypointArg)
          .filter(k => !k.startsWith('$'))
          .sort(),
      ).toEqual(['db', 'usecases']);
      expect(Object.keys(app.services['shop.services']).sort()).toEqual(['$handlers', 'db', 'usecases']);
      for (const key of BELOW) {
        expect(providesArg).not.toHaveProperty(key);
        expect(entrypointArg).not.toHaveProperty(key);
        expect(app.services['shop.services']).not.toHaveProperty(key);
      }
      expect(app.services.finder.find('a')).toBe('a');
    } finally {
      orThrow(await app.dispose());
    }
  });
});
