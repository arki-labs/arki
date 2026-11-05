// What an operator reads when mail breaks: one `mail.send` span per send, one provider span per
// attempt under it, the failure code, and an error status only for a fault (`mail.uncertain`), not
// for a refusal the caller handles. The spans must never carry an address, a subject or a body.
// Mailpit is real (a container); Resend is a paid service, so its refusals come from a scripted fetch.
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure, orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';
import { mailpit as mailpitService } from '@arki/testing/services/mailpit';

import type { FetchFn } from './http/post-json.js';
import { mail } from './dot.js';
import { failover } from './failover.js';
import { mailpit } from './http/mailpit.js';
import { resend } from './http/resend.js';
import { mailer } from './mailer.js';
import { defineTemplate } from './template.js';

const runId = `mailotel${Date.now().toString(36)}`;
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

const welcome = defineTemplate({
  name: 'welcome',
  input: z.object({ name: z.string() }),
  subject: data => `Welcome, ${data.name}`,
  text: data => `Hello ${data.name}, your code is 424242.`,
});

/** Resend answering 503 to every request: busy, so failover may move on. */
const resendDown: FetchFn = () => Promise.resolve(Response.json({ message: 'busy' }, { status: 503 }));

/** Every attribute a mail span may carry. Anything else is a leak. Dot's own spans are not checked here. */
const ALLOWED = new Set(['mail.transport', 'mail.template', 'mail.provider', 'failure.code']);

function expectNoContent(spans: ReturnType<typeof captureSpans>): void {
  for (const span of spans.finished.filter(finished => finished.name.startsWith('mail.'))) {
    expect(Object.keys(span.attributes).filter(key => !ALLOWED.has(key))).toEqual([]);
    const text = JSON.stringify(span.attributes);
    for (const secret of ['ada@example.com', 'Welcome, Ada', '424242', 're_test_key']) {
      expect(text).not.toContain(secret);
    }
  }
}

describe('mail spans', () => {
  it('a failover send is one mail.send span with a provider span per attempt under it', async () => {
    using spans = captureSpans();
    const transport = failover([resend({ apiKey: 're_test_key', fetch: resendDown }), mailpit({ baseUrl })]);
    const sent = await mailer({ transport, from: 'App <hi@app.test>' }).send(
      welcome,
      { name: 'Ada' },
      { to: 'ada@example.com' },
    );

    expect(isFailure(sent)).toBe(false);
    const send = spans.named('mail.send');
    expect(send.attributes).toEqual({ 'mail.transport': 'resend|mailpit', 'mail.template': 'welcome' });
    expect(send.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans.childrenOf(send).map(span => span.name)).toEqual(['mail.resend.send', 'mail.mailpit.send']);
    // A refusal is an answer failover handles (status 422), so it carries the code without an error status.
    const refused = spans.named('mail.resend.send');
    expect(refused.attributes).toEqual({
      'mail.provider': 'resend',
      'mail.transport': 'resend',
      'failure.code': 'mail.rejected',
    });
    expect(refused.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans.named('mail.mailpit.send').attributes['failure.code']).toBeUndefined();
    expectNoContent(spans);

    const collected = await spans.collectMetrics();
    const counter = collected.find(metric => metric.descriptor.name === 'mail.operations');
    expect(counter?.dataPoints.map(point => point.attributes)).toEqual(
      expect.arrayContaining([
        { operation: 'send', outcome: 'success' },
        { operation: 'resend.send', outcome: 'failure' },
        { operation: 'mailpit.send', outcome: 'success' },
      ]),
    );
  });

  it('a send nobody answered is mail.uncertain, a fault: error status on the provider span and the send', async () => {
    using spans = captureSpans();
    // Port 9 on loopback: nothing listens, so the request fails in transit.
    const transport = mailpit({ baseUrl: 'http://127.0.0.1:9' });
    const sent = await mailer({ transport, from: 'hi@app.test' }).sendRaw({
      to: 'ada@example.com',
      subject: 'Welcome, Ada',
      text: 'Hello Ada, your code is 424242.',
    });

    expect(isFailure(sent) && sent.code).toBe('mail.uncertain');
    for (const name of ['mail.send', 'mail.mailpit.send']) {
      expect(spans.named(name).attributes['failure.code']).toBe('mail.uncertain');
      expect(spans.named(name).status.code).toBe(SpanStatusCode.ERROR);
    }
    expect(spans.named('mail.send').attributes['mail.template']).toBeUndefined();
    expectNoContent(spans);
  });

  it('input the template refuses fails the send before any provider span', async () => {
    using spans = captureSpans();
    const sent = await mailer({ transport: mailpit({ baseUrl }), from: 'hi@app.test' }).send(
      welcome,
      // @ts-expect-error -- `name` must be a string; the schema refuses it at run time too.
      { name: 42 },
      { to: 'ada@example.com' },
    );

    expect(isFailure(sent) && sent.code).toBe('mail.invalid_input');
    expect(spans.finished.map(span => span.name)).toEqual(['mail.send']);
    expect(spans.named('mail.send').attributes['failure.code']).toBe('mail.invalid_input');
    expect(spans.named('mail.send').status.code).toBe(SpanStatusCode.UNSET);
  });

  it('in a Dot app the send nests under the usecase span that sent it', async () => {
    using spans = captureSpans();
    const mailUnit = mail({ transport: mailpit({ baseUrl }), from: 'hi@app.test' });
    const signup = defineFeature('signup')
      .needs({ mail: mailUnit.provides.mail })
      .usecases({
        welcome:
          ({ mail: mailService }) =>
          (to: string) =>
            mailService.send(welcome, { name: 'Ada' }, { to }),
      })
      .entrypoints();
    const app = orThrow(await defineApp('mail-spans').infra(mailUnit).features([signup]).start());

    const sent = await app.services['signup.usecases'].welcome('ada@example.com');
    orThrow(await app.dispose());

    expect(isFailure(sent)).toBe(false);
    const send = spans.named('mail.send');
    expect(send.parent?.name).toBe('feature.signup.welcome');
    expect(spans.named('mail.mailpit.send').parent).toBe(send);
    expectNoContent(spans);
  });
});
