/**
 * A streaming redactor for `dot env run --redact`: replaces every secret value in a byte stream
 * with `[redacted]`. It holds back only the shortest tail that could still be the start of a secret,
 * so output stays live and a secret split across two chunks is still caught.
 */
import { StringDecoder } from 'node:string_decoder';

/** Secrets shorter than this are not redacted: too likely to match ordinary output. */
export const MIN_REDACTED_LENGTH = 8;

const REDACTED = '[redacted]';

/** Feeds chunks through `write`; call `end` once the stream closes. */
export type Redactor = { write(chunk: Buffer): void; end(): void };

export function createRedactor(secrets: readonly string[], emit: (text: string) => void): Redactor {
  // Longest first, so a secret that contains another is replaced whole.
  const values = [...new Set(secrets.filter(secret => secret.length >= MIN_REDACTED_LENGTH))];
  values.sort((a, b) => b.length - a.length);
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const flush = (final: boolean): void => {
    let text = pending;
    for (const value of values) text = text.replaceAll(value, REDACTED);
    let hold = 0;
    if (!final) {
      for (let size = Math.min(text.length, (values[0]?.length ?? 1) - 1); size > 0; size--) {
        const tail = text.slice(-size);
        if (values.some(value => value.startsWith(tail))) {
          hold = size;
          break;
        }
      }
    }
    const out = text.slice(0, text.length - hold);
    pending = text.slice(text.length - hold);
    if (out !== '') emit(out);
  };

  return {
    write(chunk) {
      pending += decoder.write(chunk);
      flush(false);
    },
    end() {
      pending += decoder.end();
      flush(true);
    },
  };
}
