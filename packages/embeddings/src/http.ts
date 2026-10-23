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
