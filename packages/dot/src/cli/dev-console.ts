/**
 * The `dot dev` console: a small local web server with one page per projection that asks for one.
 *
 * A unit gives the console a page by registering a projection with `console: { title }` and exporting
 * `consolePage(document)` from the projection module (see `ProjectionManifest.console`). The console never
 * knows what a page shows. For each request it asks `dot explain` in a fresh process, so a page always reads
 * the app as it is on disk after the last restart and TypeScript apps load the way `dot explain` loads them:
 * the menu from `dot explain --json` (the projections that have a `console` title), a page from
 * `dot explain --as <format> --page --json` (the same document `--as` prints, plus the module's HTML).
 *
 * The server listens on 127.0.0.1 only and serves GET. It has no client-side dependency: no CDN, no font download.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { z } from 'zod';

/** What one `dot explain` call returned: its `data`, or why there is none. */
export type ExplainResult = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly message: string };

/** Runs `dot explain` for the app with these extra arguments (`--json` is added by the runner). */
export type ExplainRunner = (args: readonly string[]) => Promise<ExplainResult>;

const envelopeSchema = z.object({ data: z.unknown() });
const menuSchema = z.object({
  projections: z.array(z.object({ format: z.string(), console: z.object({ title: z.string() }).optional() })),
});
const pageSchema = z.object({ page: z.string() });

/** One entry of the console's menu. */
export type ConsoleMenuItem = { readonly format: string; readonly title: string };

/** The `dot explain` runner a supervisor uses: the CLI entry of this package, run in the project. */
export function cliExplainRunner(options: {
  readonly cliEntry: readonly [string, ...string[]];
  readonly cwd: string;
  readonly appFile: string;
  /** Read at every call: a full restart prepares a new env. */
  readonly env: () => Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): ExplainRunner {
  const [program, ...entry] = options.cliEntry;
  return args =>
    new Promise(resolve => {
      execFile(
        program,
        [...entry, 'explain', '--app', options.appFile, ...args, '--json'],
        { cwd: options.cwd, env: { ...options.env() }, maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 60_000 },
        (error, stdout, stderr) => {
          let parsed: z.ZodSafeParseResult<z.infer<typeof envelopeSchema>> | undefined;
          try {
            parsed = envelopeSchema.safeParse(JSON.parse(stdout));
          } catch {
            parsed = undefined;
          }
          if (parsed?.success === true && error === null) resolve({ ok: true, data: parsed.data.data });
          else resolve({ ok: false, message: (stdout.trim() || stderr.trim() || String(error?.message)).slice(0, 4000) });
        },
      );
    });
}

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * The tokens every page reads. A page styles itself with these variables only, so it follows the console's
 * light and dark themes and nobody needs a second look.
 */
const SHELL_STYLE = `
:root { color-scheme: light dark; --bg: #f7f6f2; --surface: #ffffff; --fg: #1d1d1b; --muted: #5d5c57; --line: #d8d6cd;
  --accent: #1f5f8b; --accent-fg: #ffffff; --warn: #8a5a00; --bad: #a12626; --ok: #2c6b3a; --radius: 6px;
  --font: system-ui, -apple-system, "Segoe UI", sans-serif; --mono: ui-monospace, "SF Mono", Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --surface: #1f1f1d; --fg: #ecebe6; --muted: #a3a29b;
  --line: #3a3a36; --accent: #7db6dc; --accent-fg: #101010; --warn: #e0b45a; --bad: #ee8a8a; --ok: #8fcf9f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--font); }
header.console-bar { display: flex; flex-wrap: wrap; gap: 4px 20px; align-items: baseline; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--surface); }
header.console-bar strong { font-size: 15px; }
header.console-bar a { color: var(--muted); text-decoration: none; padding: 4px 0; }
header.console-bar a[aria-current="page"] { color: var(--fg); border-bottom: 2px solid var(--accent); }
main.console-main { padding: 16px; max-width: 1600px; margin: 0 auto; }
code, pre { font-family: var(--mono); font-size: 13px; }
`;

/** One HTML document around a page: the console bar with the menu, then the page. */
export function shell(menu: readonly ConsoleMenuItem[], current: string | null, title: string, body: string): string {
  const links = [
    `<a href="/"${current === null ? ' aria-current="page"' : ''}>Pages</a>`,
    ...menu.map(
      item =>
        `<a href="/page/${encodeURIComponent(item.format)}"${item.format === current ? ' aria-current="page"' : ''}>${escapeHtml(item.title)}</a>`,
    ),
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} - dot dev</title><style>${SHELL_STYLE}</style></head><body><header class="console-bar"><strong>dot dev</strong>${links}</header><main class="console-main">${body}</main></body></html>`;
}

async function menuOf(explain: ExplainRunner): Promise<{ menu: ConsoleMenuItem[] } | { message: string }> {
  const result = await explain([]);
  if (!result.ok) return { message: result.message };
  const parsed = menuSchema.safeParse(result.data);
  if (!parsed.success) return { message: 'dot explain returned a manifest without projections.' };
  const seen = new Set<string>();
  const menu: ConsoleMenuItem[] = [];
  for (const projection of parsed.data.projections) {
    if (projection.console === undefined || seen.has(projection.format)) continue;
    seen.add(projection.format);
    menu.push({ format: projection.format, title: projection.console.title });
  }
  return { menu };
}

const problem = (message: string): string =>
  `<h1>The console could not read the app</h1><pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>`;

/** A path segment, decoded; `undefined` for a malformed escape such as `%E0%A4%A`, which `decodeURIComponent` throws on. */
function decodedSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Whether a request's `Host` names this console. The server listens on 127.0.0.1 only, but a page on another site can
 * point its own domain at 127.0.0.1 (DNS rebinding) and read the console as same-origin. That page's requests carry its
 * domain in `Host`, so only the console's own names pass. Exported so a test needs no socket.
 */
export function isConsoleHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;
}

/** The page for one request path: the HTML and its status. Exported so a test needs no socket. */
export async function respond(explain: ExplainRunner, pathname: string): Promise<{ status: number; html: string }> {
  const menuResult = await menuOf(explain);
  if (!('menu' in menuResult)) return { status: 500, html: shell([], null, 'Error', problem(menuResult.message)) };
  const { menu } = menuResult;
  if (pathname === '/') {
    const list =
      menu.length === 0
        ? '<p>No unit gave the console a page. A unit adds one by registering a projection with <code>console: { title }</code>.</p>'
        : `<ul>${menu.map(item => `<li><a href="/page/${encodeURIComponent(item.format)}">${escapeHtml(item.title)}</a></li>`).join('')}</ul>`;
    return { status: 200, html: shell(menu, null, 'Pages', `<h1>Pages</h1>${list}`) };
  }
  const match = /^\/page\/([^/]+)$/.exec(pathname);
  const format = match?.[1] === undefined ? undefined : decodedSegment(match[1]);
  const item = format === undefined ? undefined : menu.find(entry => entry.format === format);
  if (item === undefined) return { status: 404, html: shell(menu, null, 'Not found', '<h1>No such page</h1>') };
  const result = await explain(['--as', item.format, '--page']);
  const page = result.ok ? pageSchema.safeParse(result.data) : undefined;
  if (!result.ok) return { status: 500, html: shell(menu, item.format, item.title, problem(result.message)) };
  if (page === undefined || !page.success)
    return { status: 500, html: shell(menu, item.format, item.title, problem('The projection returned no page.')) };
  return { status: 200, html: shell(menu, item.format, item.title, page.data.page) };
}

/** A running console. */
export type RunningConsole = { readonly url: string; close(): Promise<void> };

/** Start the console on `127.0.0.1:port`. A port in use is returned as a message, not thrown: the console is optional. */
export function startConsole(options: {
  readonly port: number;
  readonly explain: ExplainRunner;
}): Promise<RunningConsole | { readonly message: string }> {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      if (!isConsoleHost(request.headers.host, options.port)) {
        response.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' }).end('Misdirected request');
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      respond(options.explain, pathname).then(
        ({ status, html }) => {
          response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(html);
        },
        (error: unknown) => {
          // A page that fails to render answers 500 and keeps the console running for the next request.
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(shell([], null, 'Error', problem(message)));
        },
      );
    });
    server.once('error', error => {
      resolve({ message: `console: could not listen on port ${String(options.port)} (${error.message})` });
    });
    server.listen(options.port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve({
        url: `http://127.0.0.1:${String(options.port)}/`,
        close: () =>
          new Promise<void>(done => {
            server.close(() => {
              done();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
