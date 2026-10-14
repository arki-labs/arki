import { afterEach, describe, expect, it, vi } from 'vitest';

import { sesProvider } from './ses';

// Captured shape of the SendEmailCommand input this suite inspects.
type CapturedSendInput = {
  EmailTags?: { Name: string; Value: string }[];
};

const sendMock = vi.hoisted(() => vi.fn<(command: { input: CapturedSendInput }) => Promise<{ MessageId?: string }>>());
const debugEmailsMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sesv2', () => {
  class SendEmailCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class SESv2Client {
    send = sendMock;
  }
  return { SESv2Client, SendEmailCommand };
});

vi.mock('../debug', () => ({ debugEmails: { debug: debugEmailsMock } }));

const provider = sesProvider({ region: 'eu-west-1' });

const basePayload = {
  to: 'reader@example.com',
  from: 'Novelette <no-reply@furculita.net>',
  subject: 'Sign in to Novelette',
  text: 'magic link inside',
};

afterEach(() => {
  sendMock.mockReset();
  debugEmailsMock.mockClear();
});

describe('sesProvider dropped-field handling (issue 13 M1)', () => {
  it('maps payload.tags to SES EmailTags ({ Name, Value }[])', async () => {
    sendMock.mockResolvedValue({ MessageId: 'ses-msg-1' });

    const result = await provider.send({
      ...basePayload,
      tags: [{ name: 'category', value: 'magic-link' }],
    });

    expect(result.error).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0]?.[0]?.input;
    expect(input?.EmailTags).toEqual([{ Name: 'category', Value: 'magic-link' }]);
  });

  it('omits EmailTags entirely when payload.tags is absent', async () => {
    sendMock.mockResolvedValue({ MessageId: 'ses-msg-2' });

    await provider.send(basePayload);

    const input = sendMock.mock.calls[0]?.[0]?.input;
    expect(input?.EmailTags).toBeUndefined();
  });

  it('debug-logs a dropped scheduledAt (SES v2 SendEmail cannot schedule)', async () => {
    sendMock.mockResolvedValue({ MessageId: 'ses-msg-3' });

    await provider.send({ ...basePayload, scheduledAt: '2026-08-01T09:00:00Z' });

    expect(debugEmailsMock).toHaveBeenCalledWith(expect.stringContaining('[ses] scheduledAt dropped'), {
      scheduledAt: '2026-08-01T09:00:00Z',
    });
  });

  it('debug-logs a dropped react element (Resend-only field)', async () => {
    sendMock.mockResolvedValue({ MessageId: 'ses-msg-4' });

    await provider.send({ ...basePayload, react: 'pretend-react-node' });

    expect(debugEmailsMock).toHaveBeenCalledWith(
      expect.stringContaining('[ses] react dropped (SES requires pre-rendered html)'),
    );
  });
});
