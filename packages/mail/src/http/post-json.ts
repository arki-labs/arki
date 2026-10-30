/** One JSON POST, shared by the fetch transports. Never throws. */
import type { FailureOf } from '@arki/failure';

import type { MailUncertain } from '../failures.js';
import { requestSignal, retryAfterMs, uncertain } from '../transport-failures.js';

export type FetchFn = typeof globalThis.fetch;

/**
 * What the service answered. `body` is `undefined` when it was empty or not JSON. `retryAfterMs` is
 * the service's `Retry-After`, when it sent one.
 */
export type JsonAnswer = { readonly status: number; readonly body: unknown; readonly retryAfterMs?: number };

/**
 * POSTs `body` as JSON. A request that fails in transit, times out (`timeoutMs`, default 30 s) or is
 * aborted, or whose answer cannot be read to the end, is `MailUncertain`: the service may have taken
 * the mail. Its `reason` tells a caller's cancel from a timeout and from a network fault.
 */
export async function postJson(request: {
  readonly transport: string;
  readonly fetch: FetchFn;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<JsonAnswer | FailureOf<typeof MailUncertain>> {
  let status: number;
  let text: string;
  let wait: number | undefined;
  const attempt = requestSignal(request.signal, request.timeoutMs);
  try {
    const response = await request.fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: attempt.signal,
    });
    status = response.status;
    wait = retryAfterMs(response.headers.get('retry-after'));
    text = await response.text();
  } catch (error) {
    return uncertain(request.transport, error, attempt.reason());
  }
  const retryAfter = wait === undefined ? {} : { retryAfterMs: wait };
  try {
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    return { status, body, ...retryAfter };
  } catch {
    return { status, body: undefined, ...retryAfter };
  }
}
