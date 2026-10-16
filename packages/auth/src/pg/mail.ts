/**
 * Auth mail through the app's mailer and the `@arki/mail/templates/auth` templates. The lib builds
 * no transport and names no sender: both are the mailer's. A failed send is `ARKI_AUTH_E006` with a
 * generic message, so a failure never looks like success and never leaks transport details.
 */
import { APIError } from 'better-auth/api';

import type { Mailer } from '@arki/mail';
import { magicLink, resetPassword, verifyEmail } from '@arki/mail/templates/auth';

import type { AuthLinkTemplate, AuthMailBrand, AuthMailBrandPicker, AuthTemplates } from './types.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { errorField, log } from '../log.js';

/** How long each link lives, in minutes. */
export const LINK_MINUTES = { magicLink: 5, resetPassword: 15, verifyEmail: 60 } as const;

export type AuthMailKind = keyof AuthTemplates;

export type AuthMail = {
  /** `request` is the one that asked for the mail; it picks the brand when `brand` is bound. */
  send(kind: AuthMailKind, to: string, url: string, request?: Request): Promise<void>;
};

const DEFAULT_TEMPLATES: AuthTemplates = { magicLink, verifyEmail, resetPassword };

/** E006 with a generic message: a failure never looks like success and never leaks transport details. */
const mailFailed = () =>
  new APIError('INTERNAL_SERVER_ERROR', {
    code: AUTH_ERROR_CODES.mailFailed,
    message: 'The email could not be sent. Try again later.',
  });

export function authMail(options: {
  readonly mail: Pick<Mailer, 'send'>;
  readonly templates: Partial<AuthTemplates> | undefined;
  readonly appName: string;
  readonly brand: AuthMailBrandPicker | undefined;
}): AuthMail {
  const templates: AuthTemplates = { ...DEFAULT_TEMPLATES, ...options.templates };
  const brandOf = async (kind: AuthMailKind, request: Request | undefined): Promise<AuthMailBrand> => {
    if (options.brand === undefined) return {};
    try {
      return await options.brand(request === undefined ? {} : { request });
    } catch (error) {
      log.error('The {kind} mail brand could not be picked', { kind, error: errorField(error) });
      throw mailFailed();
    }
  };
  return {
    async send(kind, to, url, request) {
      const template: AuthLinkTemplate = templates[kind];
      const brand = await brandOf(kind, request);
      const { error } = await options.mail.send(
        template,
        { appName: brand.appName ?? options.appName, url, expiresInMinutes: LINK_MINUTES[kind] },
        { to, ...(brand.from !== undefined && { from: brand.from }) },
      );
      if (error === null) {
        log.debug('Sent the {kind} mail', { kind });
        return;
      }
      log.error('The {kind} mail failed ({code})', { kind, code: error.code, transport: error.transport });
      throw mailFailed();
    },
  };
}
