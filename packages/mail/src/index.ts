// Client
export { initEmails } from './client/init';
export type { EmailClient } from './client/init';
export {
  CLOUDFLARE_EMAIL_SERVICE_FREE_QUOTA,
  createEmailClient,
  EmailClientConfigSchema,
  RESEND_FREE_QUOTA,
  UNOSEND_PRO_QUOTA,
} from './client/create';
export type { EmailClientConfig } from './client/create';
export { EmailBuilder, EmailProcedure } from './client/email-procedure';

// Providers
export { resendProvider } from './providers/resend';
export { unosendProvider } from './providers/unosend';
export { sesProvider } from './providers/ses';
export { cloudflareEmailServiceProvider } from './providers/cloudflare-email-service';
export { quotaRouter } from './providers/quota-router';
export type { QuotaStore } from './providers/quota-store';
export { kvQuotaStore } from './providers/quota-store-kv';
export type { KVLike } from './providers/quota-store-kv';
export type { EmailProvider, SendEmailPayload, SendEmailResult } from './providers/types';

// Templates are intentionally NOT re-exported here. This barrel is the JS-only
// surface (client + providers); re-exporting the `.tsx` templates from it would
// force JSX through every consumer's bundler — including raw esbuild passes that
// have no JSX loader (drizzle-kit config bundling), breaking schema generation in
// any backend whose graph reaches `@arki/mail` via `@arki/auth`. Import templates
// directly from the typed subpath instead:
//   import { MagicLinkEmail } from '@arki/mail/react/templates/magic-link';
