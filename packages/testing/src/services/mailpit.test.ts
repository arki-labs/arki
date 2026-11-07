import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { describeServiceContract, newRunId } from '../stack/contract.js';
import { mailbox, mailpit } from './mailpit.js';

async function send(httpUrl: string, to: string, subject: string): Promise<void> {
  const response = await fetch(`${httpUrl}/api/v1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: 'digest@app.test' },
      To: [{ Email: to }],
      Subject: subject,
      Text: 'hello',
      HTML: '<p><a href="https://app.test/digest/1">Open</a></p>',
    }),
  });
  expect(response.ok).toBe(true);
}

describeServiceContract({
  name: 'mailpit',
  make: () => mailpit(),
  probe: async worker => {
    const info = await fetch(`${worker.httpUrl}/api/v1/info`);
    expect(info.ok).toBe(true);
  },
  apart: async (a, b) => {
    await send(a.httpUrl, 'x@app.test', 'only in a');
    expect(await mailbox(b.httpUrl).all()).toEqual([]);
  },
});

describe('mailbox', () => {
  it('finds a mail by recipient and subject, reads its links, and clears only one recipient', async () => {
    const runId = newRunId();
    const spec = mailpit();
    const started = await spec.start({ runId });
    const slice = await spec.slice?.(started.value, { runId, workerIndex: 0 });
    if (slice === undefined) throw new Error('mailpit must slice');
    try {
      const box = mailbox(slice.value.httpUrl);
      await send(slice.value.httpUrl, 'a@app.test', 'Your digest');
      await send(slice.value.httpUrl, 'b@app.test', 'Your digest');
      const mail = await box.waitFor({ to: 'a@app.test', subject: /digest/i });
      expect(mail.to).toEqual(['a@app.test']);
      expect(mail.links()).toEqual(['https://app.test/digest/1']);
      await box.clear('a@app.test');
      expect(await box.all('a@app.test')).toEqual([]);
      const others = await box.all('b@app.test');
      expect(others).toHaveLength(1);
      await expect(box.waitFor({ to: 'a@app.test', timeoutMs: 600 })).rejects.toThrow(/MAIL_NOT_RECEIVED/);
    } finally {
      await slice.stop();
      await started.stop();
    }
  }, 120_000);
});

describe('mailbox answer shape', () => {
  async function serve(body: string): Promise<{ httpUrl: string; close: () => Promise<void> }> {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the test server has no port');
    return {
      httpUrl: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
  }

  it('refuses an answer whose shape is not Mailpit\'s instead of passing it on as mail', async () => {
    // A proxy error page or a changed API answers 200 with a body that is not a message list.
    const wrong = await serve(JSON.stringify({ messages: 'maintenance' }));
    try {
      await expect(mailbox(wrong.httpUrl).all()).rejects.toThrow(/unexpected shape/);
    } finally {
      await wrong.close();
    }
  });

  it('reads a well-formed list and ignores fields it does not use', async () => {
    const right = await serve(
      JSON.stringify({ total: 1, messages: [{ ID: 'm1', Subject: 'Hi', To: [{ Address: 'a@app.test', Name: 'A' }] }] }),
    );
    try {
      expect(await mailbox(right.httpUrl).all()).toEqual([{ id: 'm1', subject: 'Hi', to: ['a@app.test'] }]);
    } finally {
      await right.close();
    }
  });
});
