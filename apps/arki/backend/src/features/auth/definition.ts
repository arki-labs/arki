/**
 * Arki's auth declaration — plain data, browser-safe. The backend builds the server from it
 * (`core/auth`) and the start app builds its client from it, so both always agree on the sign-in
 * methods.
 *
 * Written `as const satisfies AuthDefinition` rather than with `defineAuth(...)`: the
 * `@arki/auth` root entry still re-exports the old server factories, so importing a value from it
 * pulls server code into the browser bundle. The type import is erased; the same checks
 * `defineAuth` runs happen in `createAuth` and `createAuthClient`.
 */
import type { AuthDefinition } from '@arki/auth';

import { APP_KEY, APP_NAME } from '../../info';

export const authDefinition = {
  app: { name: APP_NAME, key: APP_KEY },
  // Email + password (with reset) and magic links. The old config turned Google, Apple and
  // Facebook on only when their credentials were set, and production sets none of them.
  methods: ['password', 'magicLink'],
  // A verify link goes out at sign-up; sign-in does not wait for it.
  verifyEmail: 'send',
  // Change email and social account linking were on; account deletion was not.
  account: { changeEmail: true, linking: true },
} as const satisfies AuthDefinition;
