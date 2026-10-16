import type { PrincipalOf } from '@arki/auth';
import type { AuthRuntime, RateLimitStore } from '@arki/auth/pg';
import type { MailerOptions } from '@arki/mail';
import { createAuth } from '@arki/auth/pg';
import { mailer } from '@arki/mail';

import { db } from '../../db';
import { authDefinition } from '../../features/auth/definition';
import { Account, Session, User, verifications } from '../../features/auth/schema';

type Options = {
  /** Read once, at boot. */
  readonly runtime: () => AuthRuntime<typeof authDefinition>;
  readonly mail: MailerOptions;
  /** The shared rate-limit budget; `false` outside production only. */
  readonly rateLimit: RateLimitStore | false;
};

/**
 * Build the Arki auth from `authDefinition` via `@arki/auth/pg`. The definition decides the
 * methods; this file binds the database, the mailer and the rate-limit store.
 */
export function initAuth(options: Options) {
  return createAuth(authDefinition, {
    db,
    tables: { User, Session, Account, Verification: verifications },
    mail: mailer(options.mail),
    runtime: options.runtime,
    rateLimit: options.rateLimit === false ? false : { store: options.rateLimit },
  });
}

export type Auth = ReturnType<typeof initAuth>;

/** Who is calling: the user row (branded `UserId`, core columns), the session and the roles. */
export type Principal = PrincipalOf<Auth>;
