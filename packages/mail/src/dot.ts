/**
 * `@arki/mail` in a Dot app.
 *
 * - `mail(options)` provides `mail: Mailer`. Pass a function to build the options at boot, so
 *   `dot explain` and the manifest never read API keys.
 *
 * Queued mail (`mailOutboxPlugin`, `mailJobs`) lives in `@arki/mail/outbox`, so this entry
 * loads without `@arki/journal`.
 *
 * @example
 * defineApp('shop')
 *   .infra(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Shop <hi@shop.dev>' })))
 */
import { infra } from '@arki/dot/unit';

import type { MailerOptions } from './mailer.js';
import { mailer } from './mailer.js';

/** The mailer as a Dot service named `mail`. */
export function mail(options: MailerOptions | (() => MailerOptions)) {
  return infra({
    name: 'mail',
    configure(ctx) {
      ctx.registerService('mail', 'email');
      ctx.declareProvides('mail');
    },
    provides: { mail: () => mailer(typeof options === 'function' ? options() : options) },
  });
}
