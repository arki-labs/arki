/**
 * Auth mail through the app's mailer and the `@arki/mail/templates/auth` templates. The lib builds
 * no transport and names no sender: both are the mailer's. A failed send is `ARKI_AUTH_E006` with a
 * generic message, so a failure never looks like success and never leaks transport details.
 */
import { APIError } from 'better-auth/api';

import type { Mailer } from '@arki/mail';
import { magicLink, resetPassword, verifyEmail } from '@arki/mail/templates/auth';

import type { AuthLinkTemplate, AuthTemplates } from './types.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { log } from '../log.js';

/** How long each link lives, in minutes. */
export const LINK_MINUTES = { magicLink: 5, resetPassword: 15, verifyEmail: 60 } as const;

export type AuthMailKind = keyof AuthTemplates;

export type AuthMail = {
  send(kind: AuthMailKind, to: string, url: string): Promise<void>;
};

const DEFAULT_TEMPLATES: AuthTemplates = { magicLink, verifyEmail, resetPassword };

export function authMail(options: {
  readonly mail: Pick<Mailer, 'send'>;
  readonly templates: Partial<AuthTemplates> | undefined;
  readonly appName: string;
}): AuthMail {
  const templates: AuthTemplates = { ...DEFAULT_TEMPLATES, ...options.templates };
  return {
    async send(kind, to, url) {
      const template: AuthLinkTemplate = templates[kind];
      const { error } = await options.mail.send(
        template,
        { appName: options.appName, url, expiresInMinutes: LINK_MINUTES[kind] },
        { to },
      );
      if (error === null) {
        log.debug('Sent the {kind} mail', { kind });
        return;
      }
      log.error('The {kind} mail failed ({code})', { kind, code: error.code, transport: error.transport });
      throw new APIError('INTERNAL_SERVER_ERROR', {
        code: AUTH_ERROR_CODES.mailFailed,
        message: 'The email could not be sent. Try again later.',
      });
    },
  };
}
