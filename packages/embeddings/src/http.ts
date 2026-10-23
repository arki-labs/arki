import { is, recordSchema } from '@arki/schema';

/** The `fetch` a fetch-based provider calls. Narrower than `typeof fetch` so a test stub needs no runtime extras. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Milliseconds to wait from `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
export function retryAfterMs(read: (name: string) => string | null | undefined): number | undefined {
  const ms = Number(read('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const header = read('retry-after');
  if (header === null || header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * True when a provider's 400 body says the input exceeded the context window. Loose on purpose:
 * Voyage and Cohere do not document their wording, and a miss turns `InputTooLong` (which a caller
 * can split and retry) into an opaque `InvalidOutput`.
 */
export function mentionsContextLength(text: string): boolean {
  return /context length|context window|maximum context|too many tokens|input length|longer than|too long|exceeds? the (?:maximum|max|context)/i.test(
    text,
  );
}

/**
 * Puts each row at its `index`. A row missing, repeated or out of range would attach a vector to
 * the wrong document, so any of those is an error message instead of a reordered list.
 */
export function vectorsByIndex(data: readonly unknown[], count: number): readonly (readonly unknown[])[] | string {
  if (data.length !== count) return `expected ${count} rows, got ${data.length}`;
  const rows: { readonly index: number; readonly embedding: readonly unknown[] }[] = [];
  const seen = new Set<number>();
  for (const row of data) {
    const index = is(row, recordSchema) ? row['index'] : undefined;
    const embedding = is(row, recordSchema) ? row['embedding'] : undefined;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      return `row index ${String(index)} is not in 0..${count - 1}`;
    }
    if (seen.has(index)) return `row index ${index} appears twice`;
    if (!Array.isArray(embedding)) return `row ${index} has no embedding array`;
    seen.add(index);
    rows.push({ index, embedding });
  }
  // `count` distinct indices in 0..count-1: sorting by index is exactly input order.
  return [...rows].sort((left, right) => left.index - right.index).map(row => row.embedding);
}
