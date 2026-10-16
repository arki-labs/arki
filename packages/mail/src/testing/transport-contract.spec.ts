// Runs the shared transport contract against all four transports. Failover and the journal
// runner trust `code`, `retryable` and `acceptance` from every transport alike; one transport
// mapping a 429 or a timeout differently would cause duplicate or lost mail.
import { vi } from 'vitest';

import type { FetchFn } from '../http/post-json.js';
import type { MailTransport } from '../types.js';
import type { TransportHarness } from './transport-contract.js';
import { cloudflare } from '../http/cloudflare.js';
import { resend } from '../http/resend.js';
import { unosend } from '../http/unosend.js';
import { ses } from '../node/ses.js';
import { transportContract } from './transport-contract.js';

type SesSendOptions = { readonly abortSignal?: AbortSignal };
const sesSend = vi.hoisted(() =>
  vi.fn<(command: unknown, options?: SesSendOptions) => Promise<{ MessageId?: string }>>(),
);

vi.mock('@aws-sdk/client-sesv2', () => ({
  SendEmailCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SESv2Client: class {
    send = sesSend;
  },
}));

const noAnswer = (): Promise<Response> => Promise.reject(new Error('no answer configured'));

type FakeRequest = { readonly headers: Headers; readonly signal: AbortSignal | undefined };

/** A harness for a fetch transport: an injected fake `fetch` plays the service. */
function fetchHarness(options: {
  readonly label: string;
  readonly defaultId: string;
  readonly create: (fetch: FetchFn, quotaPerMonth: number | undefined) => MailTransport;
  readonly successBody: unknown;
  readonly expectedId: string | null;
  readonly errorBody: (status: number) => unknown;
  readonly idempotencyHeader?: string;
  readonly unsupported?: TransportHarness['unsupported'];
}): TransportHarness {
  const { idempotencyHeader } = options;
  let requests: FakeRequest[] = [];
  let answer: () => Promise<Response> = noAnswer;
  const fakeFetch: FetchFn = (_input, init) => {
    requests.push({ headers: new Headers(init?.headers), signal: init?.signal ?? undefined });
    return answer();
  };
  return {
    label: options.label,
    defaultId: options.defaultId,
    create: transportOptions => options.create(fakeFetch, transportOptions?.quotaPerMonth),
    expectedId: options.expectedId,
    succeed: () => {
      answer = () => Promise.resolve(Response.json(options.successBody, { status: 200 }));
    },
    respondWith: status => {
      answer = () => Promise.resolve(Response.json(options.errorBody(status), { status }));
    },
    failInTransit: message => {
      answer = () => Promise.reject(new TypeError(message));
    },
    requestCount: () => requests.length,
    ...(idempotencyHeader === undefined
      ? {}
      : { lastIdempotencyKey: () => requests.at(-1)?.headers.get(idempotencyHeader) ?? undefined }),
    lastSignal: () => requests.at(-1)?.signal,
    ...(options.unsupported === undefined ? {} : { unsupported: options.unsupported }),
    reset: () => {
      requests = [];
    },
  };
}

transportContract(
  fetchHarness({
    label: 'resend',
    defaultId: 'resend',
    create: (fetch, quotaPerMonth) =>
      resend({ apiKey: 're_test', fetch, ...(quotaPerMonth === undefined ? {} : { quotaPerMonth }) }),
    successBody: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' },
    expectedId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
    errorBody: status => ({ statusCode: status, name: 'validation_error', message: 'refused' }),
    idempotencyHeader: 'Idempotency-Key',
  }),
);

transportContract(
  fetchHarness({
    label: 'unosend',
    defaultId: 'unosend',
    create: (fetch, quotaPerMonth) =>
      unosend({ apiKey: 'un_test', fetch, ...(quotaPerMonth === undefined ? {} : { quotaPerMonth }) }),
    successBody: { id: 'uno_msg_1' },
    expectedId: 'uno_msg_1',
    errorBody: () => ({ message: 'refused', code: 'invalid_request' }),
    unsupported: { tags: { category: 'auth' } },
  }),
);

transportContract(
  fetchHarness({
    label: 'cloudflare',
    defaultId: 'cloudflare',
    create: (fetch, quotaPerMonth) =>
      cloudflare({
        accountId: 'acct',
        apiToken: 'token',
        fetch,
        ...(quotaPerMonth === undefined ? {} : { quotaPerMonth }),
      }),
    // The older documented shape: no `message_id`, so the id is null, never made up.
    successBody: {
      success: true,
      errors: [],
      messages: [],
      result: { delivered: ['reader@example.com', 'second@example.com'], permanent_bounces: [], queued: [] },
    },
    expectedId: null,
    errorBody: () => ({ success: false, errors: [{ code: 10_001, message: 'refused' }], messages: [], result: null }),
    unsupported: { replyTo: ['one@example.com', 'two@example.com'] },
  }),
);

let sesSignals: (AbortSignal | undefined)[] = [];
transportContract({
  label: 'ses',
  defaultId: 'ses',
  create: options =>
    ses({
      region: 'eu-west-1',
      ...(options?.quotaPerMonth === undefined ? {} : { quotaPerMonth: options.quotaPerMonth }),
    }),
  expectedId: 'ses-msg-1',
  succeed: () => {
    sesSend.mockImplementation((_command, options) => {
      sesSignals.push(options?.abortSignal);
      return Promise.resolve({ MessageId: 'ses-msg-1' });
    });
  },
  respondWith: status => {
    sesSend.mockImplementation((_command, options) => {
      sesSignals.push(options?.abortSignal);
      return Promise.reject(
        Object.assign(new Error('refused'), { name: 'MessageRejected', $metadata: { httpStatusCode: status } }),
      );
    });
  },
  failInTransit: message => {
    sesSend.mockImplementation((_command, options) => {
      sesSignals.push(options?.abortSignal);
      return Promise.reject(new Error(message));
    });
  },
  requestCount: () => sesSend.mock.calls.length,
  lastSignal: () => sesSignals.at(-1),
  reset: () => {
    sesSend.mockReset();
    sesSignals = [];
  },
});
