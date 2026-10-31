/**
 * Server-side error overlay for TanStack Start `entry-server.ts`.
 *
 * Wraps a fetch handler so that:
 *   - Thrown exceptions in dev render a readable HTML page with the stack,
 *     error name/message, and the original request URL.
 *   - Handlers that return a non-Response (`undefined`, a string, a wrapped
 *     proxy, etc.) get caught and surfaced as "Handler returned X" instead
 *     of degrading silently into the framework's HTTP layer (which is what
 *     produced the opaque `[object Response]` body when @sentry/node's
 *     OTel http instrumentation corrupted the response stream).
 *   - Production returns a minimal HTML 500 page — no stack leakage.
 *   - Every argument after the request reaches the inner handler unchanged,
 *     so Start's `{ context }` survives:
 *     `startServer(app, { handler: withServerErrorOverlay(createStartHandler(defaultStreamHandler)) })`.
 *
 * The wrapper is best-applied as the OUTER layer in `entry-server.ts`:
 * ```ts
 * import { withServerErrorOverlay } from '@arki/tanstack-start/server-error-overlay';
 *
 * const inner = async (request: Request): Promise<Response> => {
 *   // your existing fetch handler body
 *   return paraglideMiddleware(request, () => handler.fetch(request));
 * };
 *
 * export default { fetch: withServerErrorOverlay(inner) };
 * ```
 */
import { captureException } from './sentry-bridge.js';

/** A fetch handler; whatever follows the request (Start's `{ context }`) passes through untouched. */
type FetchHandler<Rest extends readonly unknown[]> = (request: Request, ...rest: Rest) => Promise<Response> | Response;

const isDev = process.env.NODE_ENV !== 'production';

export function withServerErrorOverlay<Rest extends readonly unknown[]>(
  handler: FetchHandler<Rest>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    try {
      const result = await handler(request, ...rest);
      if (!(result instanceof Response)) {
        const fakeError = new Error(
          `entry-server fetch handler returned ${describe(result)}, expected Response`,
        );
        return errorResponse(request, fakeError, 'handler-returned-non-response');
      }
      return result;
    } catch (error) {
      captureException(error, {
        tags: { source: '@arki/tanstack-start/server-error-overlay' },
        extra: { url: request.url, method: request.method },
      });
      return errorResponse(request, normalizeError(error), 'handler-threw');
    }
  };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t !== 'object') return `${t}(${String(value).slice(0, 80)})`;
  return `${(value as object).constructor?.name ?? 'object'} (${Object.prototype.toString.call(value)})`;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(typeof error === 'string' ? error : describe(error));
}

function errorResponse(request: Request, error: Error, kind: string): Response {
  if (!isDev) {
    return new Response(MINIMAL_PROD_HTML, {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  const html = renderDevErrorPage(error, request, kind);
  return new Response(html, {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function renderDevErrorPage(error: Error, request: Request, kind: string): string {
  const stack = error.stack ?? '(no stack)';
  // Cause chains are arbitrary user data: they can be cyclic (e.cause === e)
  // or unboundedly deep — walk them guarded.
  const causes: string[] = [];
  const seen = new Set<Error>([error]);
  let current = (error as Error & { cause?: unknown }).cause;
  while (current instanceof Error && !seen.has(current) && causes.length < 10) {
    seen.add(current);
    causes.push(`${current.name}: ${escapeHtml(current.message)}\n${escapeHtml(current.stack ?? '')}`);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Server error · ${escapeHtml(error.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #fafafa; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #09090b; color: #e4e4e7; } pre { background: #18181b; } }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #dc2626; }
  .meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; color: #71717a; margin-bottom: 1.5rem; }
  .card { max-width: 56rem; margin: 0 auto; }
  .label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin: 1.5rem 0 0.5rem; }
  pre { background: #f4f4f5; padding: 1rem; border-radius: 0.375rem; overflow-x: auto; font-size: 0.8125rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; padding: 0.5rem 0.75rem; background: #f4f4f5; border-radius: 0.375rem; }
  @media (prefers-color-scheme: dark) { .url { background: #18181b; } }
  footer { margin-top: 2rem; font-size: 0.75rem; color: #71717a; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(error.name)}</h1>
  <div class="meta">${escapeHtml(kind)} · dev-only · this page is shown by <code>@arki/tanstack-start/server-error-overlay</code></div>
  <div class="label">Message</div>
  <div class="url">${escapeHtml(error.message || '(empty)')}</div>
  <div class="label">Request</div>
  <div class="url">${escapeHtml(request.method)} ${escapeHtml(request.url)}</div>
  <div class="label">Stack</div>
  <pre>${escapeHtml(stack)}</pre>
  ${causes.map((c, i) => `<div class="label">Caused by (${i + 1})</div><pre>${c}</pre>`).join('')}
  <footer>To customise this page, swap <code>withServerErrorOverlay</code> in your <code>entry-server.ts</code>.</footer>
</div>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MINIMAL_PROD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Internal Server Error</title></head>
<body style="font-family:system-ui;padding:2rem"><h1>500 Internal Server Error</h1><p>Something went wrong on the server. Please try again.</p></body></html>`;
