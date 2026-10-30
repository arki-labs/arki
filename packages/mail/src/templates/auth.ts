/**
 * Mails for sign-in flows: magic link, email verification, password reset, sign-in code.
 * Portable (no React, no Zod). Each takes `appName`; the link mails take an http(s) `url` and an
 * optional `expiresInMinutes`.
 *
 * @example
 * await mail.send(magicLink, { appName: 'Acme', url }, { to: user.email });
 */
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';

import type { MailTemplate } from '../template.js';
import { defineTemplate } from '../template.js';
import { isHttpUrl, layout } from './layout.js';

export type AuthLinkInput = { readonly appName: string; readonly url: string; readonly expiresInMinutes?: number };
export type AuthLinkData = { readonly appName: string; readonly url: string; readonly expiresInMinutes: number };
export type SignInCodeInput = { readonly appName: string; readonly code: string };

const LINE_BREAK = /[\r\n]/;

/** A non-empty, single-line string field. The app name goes into the subject, where a line break is refused. */
const lineField = (key: string) => {
  const message = `${key} must be a non-empty, single-line string`;
  return z
    .string({ error: message })
    .refine(value => value.trim() !== '' && !LINE_BREAK.test(value), { error: message });
};

const urlField = z
  .string({ error: 'url must be an absolute http(s) URL' })
  .refine(isHttpUrl, { error: 'url must be an absolute http(s) URL' });

/** The input schema of a link mail; `expiresInMinutes` defaults to `defaultMinutes`. */
function linkInput(defaultMinutes: number): StandardSchemaV1<AuthLinkInput, AuthLinkData> {
  return z.object(
    {
      appName: lineField('appName'),
      url: urlField,
      expiresInMinutes: z
        .number({ error: 'expiresInMinutes must be a positive whole number' })
        .int({ error: 'expiresInMinutes must be a positive whole number' })
        .positive({ error: 'expiresInMinutes must be a positive whole number' })
        .default(defaultMinutes),
    },
    { error: 'expected an object' },
  );
}

const signInCodeInput: StandardSchemaV1<SignInCodeInput, SignInCodeInput> = z.object(
  { appName: lineField('appName'), code: lineField('code') },
  { error: 'expected an object' },
);

/** `90` → `90 minutes`, `120` → `2 hours`, `60` → `1 hour`. */
function duration(minutes: number): string {
  if (minutes % 60 !== 0) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

const IGNORE_IF_NOT_YOU = 'If you did not ask for this, you can ignore this mail.';

/** A link mail: one sentence of purpose, one button, the expiry. */
function linkTemplate<const Name extends string>(spec: {
  readonly name: Name;
  readonly defaultMinutes: number;
  readonly subject: (appName: string) => string;
  readonly purpose: (appName: string) => string;
  readonly action: string;
}): MailTemplate<StandardSchemaV1<AuthLinkInput, AuthLinkData>, Name> {
  return defineTemplate({
    name: spec.name,
    input: linkInput(spec.defaultMinutes),
    subject: data => spec.subject(data.appName),
    text: data =>
      [
        spec.purpose(data.appName),
        data.url,
        `The link expires in ${duration(data.expiresInMinutes)}.`,
        IGNORE_IF_NOT_YOU,
      ].join('\n\n'),
    html: data =>
      layout({
        title: spec.subject(data.appName),
        intro: [spec.purpose(data.appName)],
        action: { label: spec.action, url: data.url },
        outro: [`The link expires in ${duration(data.expiresInMinutes)}.`, IGNORE_IF_NOT_YOU],
      }),
  });
}

export const magicLink = linkTemplate({
  name: 'auth.magic-link',
  defaultMinutes: 15,
  subject: appName => `Sign in to ${appName}`,
  purpose: appName => `Use this link to sign in to ${appName}:`,
  action: 'Sign in',
});

export const verifyEmail = linkTemplate({
  name: 'auth.verify-email',
  defaultMinutes: 24 * 60,
  subject: appName => `Verify your email for ${appName}`,
  purpose: appName => `Confirm this email address for your ${appName} account:`,
  action: 'Verify email',
});

export const resetPassword = linkTemplate({
  name: 'auth.reset-password',
  defaultMinutes: 60,
  subject: appName => `Reset your ${appName} password`,
  purpose: appName => `Use this link to choose a new ${appName} password:`,
  action: 'Reset password',
});

export const signInCode = defineTemplate({
  name: 'auth.sign-in-code',
  input: signInCodeInput,
  subject: data => `Your ${data.appName} sign-in code`,
  text: data => [`Your code to sign in to ${data.appName}:`, data.code, IGNORE_IF_NOT_YOU].join('\n\n'),
  html: data =>
    layout({
      title: `Your ${data.appName} sign-in code`,
      intro: [`Your code to sign in to ${data.appName}:`],
      code: data.code,
      outro: [IGNORE_IF_NOT_YOU],
    }),
});
