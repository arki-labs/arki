import { afterEach, vi } from 'vitest';

import type { ProviderHarness } from './provider-contract';
import { cloudflareEmailServiceProvider } from './cloudflare-email-service';
import { runProviderContract } from './provider-contract';
import { resendProvider } from './resend';
import { sesProvider } from './ses';
import { unosendProvider } from './unosend';

const resendSend = vi.hoisted(() => vi.fn());
const sesSend = vi.hoisted(() => vi.fn());

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SendEmailCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SESv2Client: class {
    send = sesSend;
  },
}));

vi.mock('../debug', () => ({ debugEmails: { debug: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
});

function toList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Read the JSON body the provider sent to the mocked HTTP endpoint. */
function lastRequestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  const body = fetchMock.mock.calls.at(-1)?.[1]?.body;
  const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : {};
  return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
}

function fetchHarness(options: {
  label: string;
  create: ProviderHarness['create'];
  success: Response;
  failure(message: string): Response;
  recipients(body: Record<string, unknown>): string[];
}): ProviderHarness {
  const fetchMock = vi.fn<typeof fetch>();
  return {
    label: options.label,
    create: options.create,
    mockSuccess: () => {
      fetchMock.mockImplementation(async () => options.success.clone());
      vi.stubGlobal('fetch', fetchMock);
    },
    mockServiceError: message => {
      fetchMock.mockImplementation(async () => options.failure(message));
      vi.stubGlobal('fetch', fetchMock);
    },
    mockNetworkFailure: message => {
      fetchMock.mockRejectedValue(new Error(message));
      vi.stubGlobal('fetch', fetchMock);
    },
    receivedRecipients: () => options.recipients(lastRequestBody(fetchMock)),
    reset: () => fetchMock.mockReset(),
  };
}

runProviderContract(
  fetchHarness({
    label: 'unosend (HTTP mocked)',
    create: opts => unosendProvider({ apiKey: 'key', ...opts }),
    success: Response.json({ id: 'un_1' }),
    failure: message => Response.json({ message }, { status: 422 }),
    recipients: body => toList(body['to']),
  }),
);

runProviderContract(
  fetchHarness({
    label: 'cloudflare-email-service (HTTP mocked)',
    create: opts => cloudflareEmailServiceProvider({ accountId: 'acct', apiToken: 'token', ...opts }),
    success: Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { delivered: ['reader@example.com'], permanent_bounces: [], queued: [] },
    }),
    failure: message =>
      Response.json({ success: false, errors: [{ code: 1000, message }], messages: [], result: null }, { status: 400 }),
    recipients: body => toList(body['to']),
  }),
);

runProviderContract({
  label: 'resend (SDK mocked)',
  create: opts => resendProvider({ apiKey: 're_key', ...opts }),
  mockSuccess: () => resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null }),
  mockServiceError: message =>
    resendSend.mockResolvedValue({ data: null, error: { message, name: 'validation_error' } }),
  mockNetworkFailure: message => resendSend.mockRejectedValue(new Error(message)),
  receivedRecipients: () => toList(resendSend.mock.calls.at(-1)?.[0]?.to),
  reset: () => resendSend.mockReset(),
});

runProviderContract({
  label: 'ses (SDK mocked)',
  create: opts => sesProvider({ region: 'eu-west-1', ...opts }),
  mockSuccess: () => sesSend.mockResolvedValue({ MessageId: 'ses-1' }),
  mockServiceError: message =>
    sesSend.mockRejectedValue(Object.assign(new Error(message), { name: 'MessageRejected' })),
  mockNetworkFailure: message => sesSend.mockRejectedValue(new Error(message)),
  receivedRecipients: () => toList(sesSend.mock.calls.at(-1)?.[0]?.input?.Destination?.ToAddresses),
  reset: () => sesSend.mockReset(),
});
