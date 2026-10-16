/** One JSON POST, shared by the fetch transports. Never throws. */
import type { MailResult } from '../types.js';
import { failed, ok } from '../errors.js';
import { uncertain } from '../transport-failures.js';

export type FetchFn = typeof globalThis.fetch;

/** What the service answered. `body` is `undefined` when it was empty or not JSON. */
export type JsonAnswer = { readonly status: number; readonly body: unknown };

/**
 * POSTs `body` as JSON. A request that fails in transit, times out or is aborted, or whose
 * answer cannot be read to the end, is `ARKI_MAIL_E007`: the service may have taken the mail.
 */
export async function postJson(request: {
  readonly transport: string;
  readonly fetch: FetchFn;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal?: AbortSignal;
}): Promise<MailResult<JsonAnswer>> {
  let status: number;
  let text: string;
  try {
    const response = await request.fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    return failed(uncertain(request.transport, error));
  }
  try {
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    return ok({ status, body });
  } catch {
    return ok({ status, body: undefined });
  }
}
