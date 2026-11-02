/**
 * Queued mail in a Dot app. A separate entry from `@arki/mail/dot` because it needs
 * `@arki/journal`, an optional peer: an app that only sends mail never installs the journal.
 *
 * - `mailOutboxPlugin({ tables })` provides `mailOutbox`, queued mail on the journal; it needs `mail`
 *   from `@arki/mail/dot`.
 * - `mailJobs()` runs that queue in the journal worker: `journalWorker({ jobs: mailJobs() })`.
 *
 * @example
 * defineApp('shop')
 *   .infra(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Shop <hi@shop.dev>' })))
 *   .infra(mailOutboxPlugin({ tables }))
 *   .entrypoints(journalWorker({ jobs: mailJobs() }))
 */
import type { Service } from '@arki/dot/unit';
import type { JournalTables } from '@arki/journal';
import type { JobsSource } from '@arki/journal/dot';
import type { Backoff } from '@arki/resilience';
import { infra, service } from '@arki/dot/unit';

import type { Mailer } from './mailer.js';
import type { MailOutbox } from './pg/index.js';
import { mailOutbox } from './pg/index.js';

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
