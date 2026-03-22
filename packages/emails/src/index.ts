// Client
export { initEmails } from './client/init';
export type { EmailClient } from './client/init';
export { createEmailClientFromEnv } from './client/auto';
export { EmailProcedure } from './client/email-procedure';

// Providers
export { resendProvider } from './providers/resend';
export { unosendProvider } from './providers/unosend';
export { quotaRouter } from './providers/quota-router';
export type { EmailProvider, SendEmailPayload, SendEmailResult } from './providers/types';

// Templates
export * from './templates/arki-magic-link';
export * from './templates/notion-magic-link';
export * from './templates/plaid-verify-identity';
export * from './templates/vercel-invite-user';
export * from './templates/stripe-welcome';
