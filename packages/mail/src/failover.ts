/**
 * Several transports as one. Two rules decide where a mail goes:
 *
 * - A transport over its monthly quota is skipped. When every transport is, nothing is sent
 *   (`MailQuotaExhausted`): a quota is a budget. Add a transport without a quota as a deliberate
 *   unlimited fallback.
 * - After a send fails, the next transport is tried only when the provider surely did not take
 *   the mail (`MailRejected`) and trying again can help (`retryable`). After a timeout the first provider
 *   may already be delivering it; a second provider would send a duplicate. That failure is
 *   returned, and the caller (the journal worker for queued mail) retries later.
 */
import { isFailure } from '@arki/failure';

import type { QuotaStore } from './quota-store.js';
import type { MailTransport, TransportFailure } from './types.js';
import { invalidConfig } from './errors.js';
import { MailQuotaExhausted, MailRejected } from './failures.js';
import { errorField, log } from './log.js';
import { inMemoryQuotaStore } from './quota-store.js';

/** The UTC month as `YYYY-MM`, the key quotas are counted under. */
const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

export type FailoverOptions = {
  /** Where sends are counted. Default: in this process only. */
  readonly store?: QuotaStore;
  /** The clock, for tests. */
  readonly now?: () => Date;
};

/** Throws `ARKI_MAIL_E001` when the list is empty or two transports share an id. */
export function assertTransports(transports: readonly MailTransport[]): void {
  if (transports.length === 0) invalidConfig('At least one transport is required.');
  const seen = new Set<string>();
  for (const { id } of transports) {
    if (id.trim() === '') invalidConfig('A transport id is empty.');
    if (seen.has(id)) invalidConfig(`Two transports have the id "${id}". Pass a distinct \`id\` to each.`);
    seen.add(id);
  }
}

/** One transport that tries `transports` in order. Its id is theirs, joined by `|`. */
export function failover(transports: readonly MailTransport[], options: FailoverOptions = {}): MailTransport {
  assertTransports(transports);
  const store = options.store ?? inMemoryQuotaStore();
  const now = options.now ?? (() => new Date());

  // A counter that cannot be read must not stop sign-in mail: the transport counts as in budget.
  const overQuota = async (transport: MailTransport, month: string): Promise<boolean> => {
    if (transport.quotaPerMonth === undefined) return false;
    try {
      return (await store.getSent(transport.id, month)) >= transport.quotaPerMonth;
    } catch (error) {
      log.warn('could not read the quota counter for {transport}; sending anyway', {
        transport: transport.id,
        error: errorField(error),
      });
      return false;
    }
  };

  // The mail is already accepted: a failing counter must not turn that into an error, or the
  // caller would retry and send it twice.
  const count = async (transport: string, month: string): Promise<void> => {
    try {
      await store.increment(transport, month);
    } catch (error) {
      log.warn('could not count a send for {transport} in {month}', { transport, month, error: errorField(error) });
    }
  };

  return {
    id: transports.map(transport => transport.id).join('|'),
    async send(message, sendOptions) {
      const month = monthOf(now());
      let lastFailure: TransportFailure | undefined;
      for (const transport of transports) {
        if (await overQuota(transport, month)) {
          log.debug('skipping {transport}: over its quota for {month}', { transport: transport.id, month });
          continue;
        }
        const result = await transport.send(message, sendOptions);
        if (!isFailure(result)) {
          if (transport.quotaPerMonth !== undefined) await count(transport.id, month);
          return result;
        }
        lastFailure = result;
        // Only a refusal surely left the mail untaken; an uncertain send may already be delivering it.
        const nextMayHelp = MailRejected.is(result) && result.data.retryable;
        if (!nextMayHelp) return result;
        log.debug('{transport} refused the mail ({code}); trying the next transport', {
          transport: transport.id,
          code: result.code,
        });
      }
      return lastFailure ?? MailQuotaExhausted({ month });
    },
  };
}
