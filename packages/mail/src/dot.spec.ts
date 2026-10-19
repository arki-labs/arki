/**
 * Mail in a Dot app. Why: wiring mistakes must fail at boot, not at the first password reset;
 * `dot explain` must not need production secrets; and queued mail must run in the same journal
 * worker as everything else.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot/plugin';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

import type { MailerOptions } from './mailer.js';
import type { MailMessage, MailTransport } from './types.js';
import { mail, mailJobs, mailOutboxPlugin } from './dot.js';
import { logTransport } from './log-transport.js';
import { defineTemplate } from './template.js';

const tables = journalTables();
const journal = initJournal({ tables }).compose({});
let db: PgliteDatabase;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(async () => {
  await client.close();
});

const welcome = defineTemplate({
  name: 'welcome',
  input: z.object({ name: z.string() }),
  subject: data => `Welcome, ${data.name}`,
  text: data => `Hello ${data.name}.`,
});

function recording() {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    id: 'rec',
    send: message => {
      sent.push(message);
      return Promise.resolve({ id: 'm1', transport: 'rec', status: 'accepted' as const, recipients: [] });
    },
  };
  return { transport, sent };
}

describe('mail()', () => {
  it('the function form is not called to build the manifest, so explain needs no secrets', () => {
    const options = vi.fn((): MailerOptions => ({ transport: logTransport(), from: 'hi@app.dev' }));
    const configured = orThrow(defineApp('mail-manifest').use(mail(options)).configure());
    expect(configured.manifest.services).toEqual([{ name: 'mail', plugin: 'mail', kind: 'email' }]);
    expect(options).not.toHaveBeenCalled();
  });

  it('boot provides a typed mailer', async () => {
    const { transport, sent } = recording();
    const app = await orThrow(
      defineApp('mail-boot')
        .use(mail({ transport, from: 'hi@app.dev' }))
        .boot(),
    );
    const result = await app.services.mail.send(welcome, { name: 'Ada' }, { to: 'ada@example.com' });
    expect(result).toMatchObject({ id: 'm1' });
    expect(sent[0]?.subject).toBe('Welcome, Ada');
    await orThrow(app.dispose());
  });
});

describe('mailOutboxPlugin() and mailJobs()', () => {
  it('without the mail service it does not compile, and at run time it fails at boot', async () => {
    // @ts-expect-error -- boot() asks for the missing `mail` service
    const failure = await defineApp('mail-outbox-alone').use(mailOutboxPlugin({ tables })).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: { message: expect.stringMatching(/mail/) } });
  });

  it('a mail queued through the service is sent by the journal worker runner', async () => {
    const { transport, sent } = recording();
    const app = await orThrow(
      defineApp('mail-outbox')
        .use(mail({ transport, from: 'hi@app.dev' }))
        .use(mailOutboxPlugin({ tables }))
        .boot(),
    );
    await orThrow(
      db.transaction(tx => app.services.mailOutbox.enqueue(tx, welcome, { name: 'Ada' }, { to: 'ada@example.com' })),
    );
    const runner = await mailJobs().build([], { mailOutbox: app.services.mailOutbox, db });
    while ((await journal.drain(db, { jobs: runner })) > 0);
    expect(sent.map(message => message.to)).toEqual(['ada@example.com']);
    await orThrow(app.dispose());
  });
});
