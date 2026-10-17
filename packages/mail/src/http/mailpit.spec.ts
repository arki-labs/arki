// The Mailpit transport is only worth anything if a real Mailpit keeps what it sends. So this
// spec starts a real Mailpit container and reads the mail back over Mailpit's own API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';
import { mailbox, mailpit as mailpitService } from '@arki/testing/services/mailpit';

import { MailRejected, MailUncertain } from '../failures.js';
import { mailpit } from './mailpit.js';

const runId = `mail${Date.now().toString(36)}`;
const service = mailpitService();
let stopService: () => Promise<void> = () => Promise.resolve();
let baseUrl = '';

beforeAll(async () => {
  const started = await service.start({ runId });
  const slice = await service.slice?.(started.value, { runId, workerIndex: 0 });
  if (slice === undefined) throw new Error('the mailpit service must slice');
  baseUrl = slice.value.httpUrl;
  stopService = async () => {
    await slice.stop();
    await started.stop();
  };
}, 120_000);

afterAll(async () => {
  await stopService();
});

describe('mailpit transport', () => {
  it('delivers every field the app set, so a test can read the digest it really sent', async () => {
    const transport = mailpit({ baseUrl });
    const sent = orThrow(
      await transport.send(
        {
          from: 'Avocabo <digest@avocabo.test>',
          to: ['Reader One <reader-1@avocabo.test>'],
          cc: 'copy@avocabo.test',
          bcc: 'hidden@avocabo.test',
          replyTo: 'support@avocabo.test',
          subject: 'Your first digest',
          text: 'Three stories today.',
          html: '<p><a href="https://app.avocabo.test/digest/d_1">Open</a></p>',
          headers: { 'List-Unsubscribe': '<https://app.avocabo.test/unsubscribe>' },
          tags: { kind: 'digest' },
        },
        {},
      ),
    );
    expect(sent.transport).toBe('mailpit');
    expect(sent.status).toBe('accepted');
    expect(sent.id).toEqual(expect.any(String));

    const mail = await mailbox(baseUrl).waitFor({ to: 'reader-1@avocabo.test', subject: 'Your first digest' });
    expect(mail.text).toContain('Three stories today.');
    expect(mail.links()).toEqual(['https://app.avocabo.test/digest/d_1']);
    const headers = await fetch(`${baseUrl}/api/v1/message/${mail.id}/headers`);
    const raw: unknown = await headers.json();
    expect(JSON.stringify(raw)).toContain('List-Unsubscribe');
    expect(JSON.stringify(raw)).toContain('Avocabo');
  });

  it('returns a rejection, not a throw, when Mailpit refuses the mail', async () => {
    const transport = mailpit({ baseUrl });
    const refused = await transport.send(
      { from: 'a@avocabo.test', to: [], subject: 's', text: 't' },
      {},
    );
    expect(MailRejected.is(refused)).toBe(true);
  });

  it('returns an uncertain failure when nobody answers', async () => {
    const transport = mailpit({ baseUrl: 'http://127.0.0.1:1' });
    const lost = await transport.send({ from: 'a@b.dev', to: 'c@d.dev', subject: 's', text: 't' }, {});
    expect(MailUncertain.is(lost)).toBe(true);
  });
});
