/**
 * Serves the built fixture app: files from `dist/client/`, everything else
 * through the Start server entry. Run by the e2e fixture with
 * `node --experimental-strip-types`, so it is killed and restarted in
 * milliseconds without a rebuild. Node, not Bun: `Bun.serve`'s default idle
 * timeout (10 s) is shorter than the live stream's heartbeat (15 s).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listen } from '@arki/http';

type ServerEntry = { readonly default: { readonly fetch: (request: Request) => Promise<Response> } };

function isServerEntry(module: unknown): module is ServerEntry {
  if (typeof module !== 'object' || module === null || !('default' in module)) return false;
  const entry = module.default;
  return typeof entry === 'object' && entry !== null && 'fetch' in entry && typeof entry.fetch === 'function';
}

/** The client build is JavaScript and CSS only. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const distDir = fileURLToPath(new URL('dist/', import.meta.url));
const clientDir = path.resolve(distDir, 'client');

const port = Number(process.env['PORT']);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a port number, got "${process.env['PORT']}"`);

const entry: unknown = await import(pathToFileURL(path.resolve(distDir, 'server/server.js')).href);
if (!isServerEntry(entry))
  throw new Error('dist/server/server.js has no default `{ fetch }` export; run `vite build`.');
const app = entry.default;

/** A built asset, or `undefined` to let the app answer (its router 404s unknown paths). */
async function clientFile(url: URL): Promise<Response | undefined> {
  const file = path.resolve(clientDir, `.${decodeURIComponent(url.pathname)}`);
  const type = CONTENT_TYPES[path.extname(file)];
  if (type === undefined || !file.startsWith(`${clientDir}/`)) return undefined;
  // A missing file is not an error here: the app answers the path instead.
  const body = await readFile(file, 'utf8').catch(() => null);
  return body === null ? undefined : new Response(body, { headers: { 'content-type': type } });
}

await listen(async request => (await clientFile(new URL(request.url))) ?? app.fetch(request), {
  port,
  hostname: '127.0.0.1',
});
