import type { MailTransport } from './types.js';
import { log } from './log.js';
import { listOf } from './message.js';

/**
 * Sends nothing: logs each mail at debug level (`DEBUG=arki:mail`) and reports it as
 * `simulated`. For local development, in place of a real transport.
 */
export function logTransport(options: { readonly id?: string } = {}): MailTransport {
  const id = options.id ?? 'log';
  return {
    id,
    send(message) {
      const to = listOf(message.to);
      log.debug('mail not sent ({transport}): "{subject}" to {to}\n{text}', {
        transport: id,
        subject: message.subject,
        to: to.join(', '),
        text: message.text,
      });
      return Promise.resolve({
        id: null,
        transport: id,
        status: 'simulated',
        recipients: to.map(address => ({ address, status: 'accepted' })),
      });
    },
  };
}
