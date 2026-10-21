/**
 * `@arki/mail` in a Dot app.
 *
 * - `mail(options)` provides `mail: Mailer`. Pass a function to build the options at boot, so
 *   `dot explain` and the manifest never read API keys.
 * - `mailOutboxPlugin({ tables })` provides `mailOutbox`, queued mail on the journal; it needs `mail`.
 * - `mailJobs()` runs that queue in the journal worker: `journalWorker({ jobs: mailJobs() })`.
 *
 * @example
 * defineApp('shop')
 *   .infra(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Shop <hi@shop.dev>' })))
 *   .infra(mailOutboxPlugin({ tables }))
 */
import type { Service } from '@arki/dot/unit';
import type { JournalTables } from '@arki/journal';
import type { JobsSource } from '@arki/journal/dot';
import type { Backoff } from '@arki/resilience';
import { infra, service } from '@arki/dot/unit';

import type { Mailer, MailerOptions } from './mailer.js';
import type { MailOutbox } from './pg/index.js';
import { mailer } from './mailer.js';
import { mailOutbox } from './pg/index.js';

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

export type MailOutboxPluginOptions = {
  readonly tables: Pick<JournalTables, 'jobs'>;
  /** Waits between tries. Default: 5 s doubling to 1 h, 5 tries in all. */
  readonly retry?: Backoff;
  /** Largest stored message, in bytes of JSON. Default 256 KiB. */
  readonly maxBytes?: number;
};

/** Queued mail on the journal as a Dot service named `mailOutbox`. Needs the `mail` service. */
export function mailOutboxPlugin(options: MailOutboxPluginOptions) {
  return infra({
    name: 'mail-outbox',
    needs: { mail: service<Mailer>() },
    configure(ctx) {
      ctx.registerService('mailOutbox', 'queue');
      ctx.declareProvides('mailOutbox');
    },
    provides: { mailOutbox: ({ mail: mailService }) => mailOutbox({ ...options, mailer: mailService }) },
  });
}

/** The queued-mail runner for `journalWorker({ jobs })`. A worker without `mailOutbox` fails at boot. */
export function mailJobs(): JobsSource<{ readonly mailOutbox: Service<MailOutbox> }> {
  return {
    needs: { mailOutbox: service<MailOutbox>() },
    build: (_features, services) => services.mailOutbox.runner,
  };
}
