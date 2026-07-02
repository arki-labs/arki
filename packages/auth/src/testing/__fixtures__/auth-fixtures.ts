/**
 * Two auth instances from the REAL `defineAuthBackend`, differing only in whether
 * they pass an explicit `emailAndPassword` block. Under NODE_ENV=production the
 * WITH-explicit instance exposes signUpEmail; the WITHOUT one does not. The
 * self-test uses these to prove the helper catches the C1 bug.
 *
 * Module-top-level construction means NODE_ENV must already be 'production' when
 * this module is first imported — the self-test guarantees that by importing it
 * only through the helper (which flips env first). PGlite is in-memory: no
 * network, no docker — keeps US-01 a true unit test.
 */
import { initDbRuntimeLocal } from '@arki/db/runtime-local';

import { defineAuthBackend } from '../../define-auth-backend';

const { db } = await initDbRuntimeLocal({ memory: true }, { relations: {} });

const schema = {
  user: {},
  account: {},
  session: {},
  verification: {},
};

const shared = {
  db,
  schema,
  appName: 'fixture',
  appKey: 'fixture',
  baseUrl: 'http://localhost',
  productionUrl: 'http://localhost',
  secret: 'fixture-secret-at-least-32-characters-long',
};

export const authWithExplicit = defineAuthBackend({
  ...shared,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    sendResetPassword: async () => {},
  },
});

export const authWithoutExplicit = defineAuthBackend(shared);
