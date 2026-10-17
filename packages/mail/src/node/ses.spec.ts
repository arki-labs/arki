// The journal is the only retrier: if the SDK also retried, one queued mail could hit SES many
// times per attempt and the backoff schedule would lie. And a caller's abort must reach the SDK,
// or a cancelled send keeps running.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { orThrow } from '@arki/failure';

import type { MailMessage } from '../types.js';
import { MailRejected, MailUncertain } from '../failures.js';
import { ses } from './ses.js';

type SesSendOptions = { readonly abortSignal?: AbortSignal };
type SesCommand = { readonly input: unknown };
const sdk = vi.hoisted(() => ({
  configs: new Array<unknown>(),
  send: vi.fn<(command: SesCommand, options?: SesSendOptions) => Promise<{ MessageId?: string }>>(),
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SendEmailCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SESv2Client: class {
    send = sdk.send;
    constructor(config: unknown) {
      sdk.configs.push(config);
    }
  },
}));

const message: MailMessage = {
  from: 'Acme <no-reply@example.com>',
  to: 'reader@example.com',
  subject: 'Sign in',
  text: 'link inside',
};

beforeEach(() => {
  sdk.send.mockReset();
  sdk.configs.length = 0;
});

describe('ses', () => {
  it('builds the SDK client with retries off (maxAttempts: 1)', async () => {
    sdk.send.mockResolvedValue({ MessageId: 'ses-1' });
    await orThrow(ses({ region: 'eu-west-1' }).send(message, {}));
    expect(sdk.configs).toEqual([{ region: 'eu-west-1', maxAttempts: 1 }]);
  });

  it("forwards the caller's signal to the SDK as abortSignal", async () => {
    sdk.send.mockResolvedValue({ MessageId: 'ses-1' });
    const controller = new AbortController();
    await orThrow(ses({ region: 'eu-west-1' }).send(message, { signal: controller.signal }));
    expect(sdk.send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });

  it('an abort (no HTTP status) is uncertain: SES may have taken the mail', async () => {
    sdk.send.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    expect(MailUncertain.is(await ses({ region: 'eu-west-1' }).send(message, {}))).toBe(true);
  });

  it('carries tags as EmailTags, and no MessageId means id null', async () => {
    sdk.send.mockResolvedValue({});
    const data = orThrow(await ses({ region: 'eu-west-1' }).send({ ...message, tags: { kind: 'auth' } }, {}));
    expect(data.id).toBeNull();
    expect(sdk.send.mock.calls[0]?.[0].input).toMatchObject({ EmailTags: [{ Name: 'kind', Value: 'auth' }] });
  });

  it('keeps the SES error name as providerCode', async () => {
    sdk.send.mockRejectedValue(
      Object.assign(new Error('Email address is not verified.'), {
        name: 'MessageRejected',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const result = await ses({ region: 'eu-west-1' }).send(message, {});
    expect(MailRejected.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { retryable: false, providerCode: 'MessageRejected' } });
  });
});
