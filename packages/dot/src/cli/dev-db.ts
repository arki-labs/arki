/**
 * The database step of `dot dev`. Safety first: `dot dev` boots the app, and
 * boot applies the committed migrations, so this step decides which database
 * the preflight and the runner may see.
 *
 *   - pglite (`--db pglite`, or `auto` without a URL): `DB_URL` and
 *     `DATABASE_URL` are removed from the env the app gets, so nothing can
 *     migrate a URL the user did not pick.
 *   - pg (`--db pg`, or `auto` with a URL): the host must be this machine or
 *     a service of the project's docker compose file; any other host is
 *     refused unless `--allow-remote-db`. A closed port with a compose file
 *     starts that one service (`docker compose up -d <service>`). It never
 *     stops a service and never touches volumes.
 *
 * The URL's password never reaches a log line, an event or a failure.
 */
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { DecryptionFailed, decryptValue, FileReadFailed, findPrivateKey, findRoot, isEncrypted } from '@arki/env/node';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { DevEvent } from './dev-events.js';
import type { Probe } from './dev-net.js';
import { pollUntil, probeTcp } from './dev-net.js';
import { DevDbUnreachable, DevRemoteDbRefused } from './failures.js';

const debugDb = getLogger('arki:dot:cli:dev');

export type DbChoice = 'auto' | 'pglite' | 'pg';

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Run a program to completion. Injectable in tests. A missing program resolves with code 127. */
export type Exec = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<ExecResult>;

export const execFile: Exec = (command, args, options) =>
  new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', error => {
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.once('close', code => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

type Env = Readonly<Record<string, string>>;

/** The env files of the project, lowest precedence first (the Vite order for the `development` mode). */
export const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'] as const;

type EnvSource = { readonly name: string; readonly values: Readonly<Record<string, string | undefined>> };

/**
 * A file's values with `encrypted:` ones opened by the file's private key, so the database check
 * sees the real URL and the app gets real values. A value no key opens stays ciphertext: the check
 * then refuses it as not local (fail closed).
 */
function decrypted(
  file: string,
  values: Readonly<Record<string, string | undefined>>,
  processEnv: Readonly<Record<string, string | undefined>>,
) {
  if (!Object.values(values).some(value => value !== undefined && isEncrypted(value))) return values;
  const found = findPrivateKey(file, { root: findRoot(path.dirname(file)), env: processEnv });
  if (isFailure(found)) return found;
  if (found === undefined) return values;
  const open = (value: string) => {
    for (const key of found.keys) {
      const result = decryptValue(value, key);
      if (!isFailure(result)) return result;
    }
    return DecryptionFailed();
  };
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    const opened = value !== undefined && isEncrypted(value) ? open(value) : value;
    if (isFailure(opened)) return opened;
    result[key] = opened;
  }
  return result;
}

/** Each env file of the project (a missing one is empty), then the process env: lowest precedence first. */
async function envSources(cwd: string, processEnv: Readonly<Record<string, string | undefined>>) {
  const sources: EnvSource[] = [];
  for (const name of ENV_FILES) {
    const file = path.join(cwd, name);
    try {
      const values = decrypted(file, parseEnv(await readFile(file, 'utf8')), processEnv);
      if (isFailure(values)) return values;
      sources.push({ name, values });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        return FileReadFailed({ file }, { cause: error });
    }
  }
  sources.push({ name: 'process env', values: processEnv });
  return sources;
}

function merge(sources: readonly EnvSource[]): Env {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.values)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/** The project's env files merged in precedence order, overridden by the process env. */
export async function mergedEnv(cwd: string, processEnv: Readonly<Record<string, string | undefined>>) {
  const sources = await envSources(cwd, processEnv);
  return isFailure(sources) ? sources : merge(sources);
}

/** The URL for display: password replaced by `***`, also a `password` query parameter. */
export function redactUrl(url: URL): string {
  const copy = new URL(url.href);
  if (copy.password !== '') copy.password = '***';
  if (copy.searchParams.has('password')) copy.searchParams.set('password', '***');
  return copy.href;
}

/** `localhost`, `127.0.0.0/8`, `::1`, or a Unix socket directory. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === 'localhost' || name === '::1' || name === '[::1]' || name.startsWith('/')) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name);
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as const;

const composeConfigZod = z.object({
  services: z
    .record(
      z.string(),
      z.object({
        ports: z
          .array(z.object({ published: z.union([z.string(), z.number()]).optional(), target: z.number().optional() }))
          .optional(),
      }),
    )
    .default({}),
});

export type ComposeService = { readonly name: string; readonly publishedPorts: readonly number[] };

async function exists(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * The services of the project's compose file, from `docker compose config
 * --format json`. Null without a compose file; empty when docker cannot read it.
 */
export async function composeServices(cwd: string, exec: Exec): Promise<readonly ComposeService[] | null> {
  let found = false;
  for (const name of COMPOSE_FILES) {
    if (await exists(path.join(cwd, name))) found = true;
  }
  if (!found) return null;
  const result = await exec('docker', ['compose', 'config', '--format', 'json'], { cwd });
  if (result.code !== 0) {
    debugDb.debug('docker compose config failed with code {code}', { code: result.code });
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const parsed = composeConfigZod.safeParse(json);
  if (!parsed.success) return [];
  return Object.entries(parsed.data.services).map(([name, service]) => ({
    name,
    publishedPorts: (service.ports ?? [])
      .map(port => Number(port.published))
      .filter(port => Number.isInteger(port) && port > 0),
  }));
}

export type DbEvent = Extract<DevEvent, { readonly kind: 'db' }>;

/** What the database step decided: the event, and the env the preflight and runner get. */
export type PreparedDb = { readonly event: DbEvent; readonly env: Env };

export type PrepareDbOptions = {
  readonly cwd: string;
  readonly db: DbChoice;
  readonly allowRemoteDb: boolean;
  /** The process env; merged over `.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec?: Exec | undefined;
  readonly probe?: Probe | undefined;
  readonly lookup?: Lookup | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Progress lines (`starting compose service db`). */
  readonly info?: ((line: string) => void) | undefined;
  /** How long to wait for a started compose service. Default 30 s. */
  readonly startTimeoutMs?: number | undefined;
  /** How often to probe a starting service. Default 500 ms. */
  readonly pollIntervalMs?: number | undefined;
};

function urlOf(env: Env): string | undefined {
  // An empty value (`DB_URL=` in .env) counts as unset.
  const url = env['DB_URL'] ?? env['DATABASE_URL'];
  return url === undefined || url === '' ? undefined : url;
}

function splitHosts(raw: string): string[] {
  return raw
    .split(',')
    .map(host => host.trim())
    .filter(host => host !== '');
}

/**
 * Every host a driver could connect to: the authority and every `host`
 * query parameter (drivers differ on which repeated one wins), each a
 * comma list.
 */
function hostsOf(url: URL): readonly string[] {
  return [...splitHosts(url.hostname), ...url.searchParams.getAll('host').flatMap(raw => splitHosts(raw))];
}

/** The host node-postgres connects to: the last `host` parameter, else the authority. */
function connectHost(url: URL): string | undefined {
  const fromParams = url.searchParams.getAll('host').flatMap(raw => splitHosts(raw));
  return fromParams.at(-1) ?? splitHosts(url.hostname)[0];
}

/** Resolve a host name to its addresses; null when it does not resolve. Injectable in tests. */
export type Lookup = (host: string) => Promise<readonly string[] | null>;

export const lookupHost: Lookup = async host => {
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.map(entry => entry.address);
  } catch {
    return null;
  }
};

/** A loopback address, also IPv4-mapped (`::ffff:127.0.0.1`). */
function isLoopbackAddress(address: string): boolean {
  return isLoopbackHost(address.replace(/^::ffff:/i, ''));
}

type HostCheck = {
  readonly services: () => Promise<readonly ComposeService[] | null>;
  readonly lookup: Lookup;
};

/**
 * The first host of `raw` that is not local, or null when every one is:
 * loopback, or a compose service whose name does not resolve to anything
 * else on this machine. An unparsable URL or one without a host is not local.
 */
async function remoteHostOf(raw: string, check: HostCheck): Promise<{ target: string; host: string } | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { target: '<invalid>', host: '<invalid>' };
  }
  const target = redactUrl(url);
  const hosts = hostsOf(url);
  if (hosts.length === 0) return { target, host: '<none>' };
  for (const host of hosts) {
    if (isLoopbackHost(host)) continue;
    const services = await check.services();
    if (services?.some(service => service.name === host) === true) {
      // A service name is resolved by this machine's DNS: it must not lead elsewhere.
      const addresses = await check.lookup(host);
      if (addresses === null || addresses.every(address => isLoopbackAddress(address))) continue;
    }
    return { target, host };
  }
  return null;
}

const DB_URL_KEYS = ['DB_URL', 'DATABASE_URL'] as const;

/** The driver `--db` picks with this env: `auto` is pg when a URL is set. */
export function selectDriver(db: DbChoice, env: Env): 'pglite' | 'pg' {
  return db === 'pglite' || (db === 'auto' && urlOf(env) === undefined) ? 'pglite' : 'pg';
}

/** `env` without `DB_URL` and `DATABASE_URL`: under pglite, no URL may reach the app. */
export function withoutDbUrls(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'DB_URL' && key !== 'DATABASE_URL'));
}

/**
 * Decide the database, check it is local, and start its compose service
 * when it is closed. Fails closed: every `DB_URL` / `DATABASE_URL` value in
 * the process env and in every env file must be local, under pglite too,
 * because a runner (Vite, Nitro) may load those files again on its own.
 */
export async function prepareDb(options: PrepareDbOptions): Promise<PreparedDb | Failure> {
  const sources = await envSources(options.cwd, options.env);
  if (isFailure(sources)) return sources;
  const env = merge(sources);
  const exec = options.exec ?? execFile;
  let services: readonly ComposeService[] | null | undefined;
  const loadServices = async (): Promise<readonly ComposeService[] | null> => {
    services ??= await composeServices(options.cwd, exec);
    return services;
  };
  if (!options.allowRemoteDb) {
    const check: HostCheck = { services: loadServices, lookup: options.lookup ?? lookupHost };
    for (const source of sources) {
      for (const key of DB_URL_KEYS) {
        const value = source.values[key];
        if (value === undefined || value === '') continue;
        const remote = await remoteHostOf(value, check);
        if (remote !== null) return DevRemoteDbRefused({ ...remote, source: `${key} in ${source.name}` });
      }
    }
  }

  const raw = urlOf(env);
  if (selectDriver(options.db, env) === 'pglite') {
    return { event: { kind: 'db', driver: 'pglite', target: 'embedded', owned: false }, env: withoutDbUrls(env) };
  }

  if (raw === undefined)
    return DevDbUnreachable({ target: '<not set>', reason: 'neither DB_URL nor DATABASE_URL is set' });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DevDbUnreachable({ target: '<invalid>', reason: 'DB_URL is not a valid URL' });
  }
  const target = redactUrl(url);
  const probe = options.probe ?? probeTcp;
  // Every host was checked above unless --allow-remote-db; probe the one the driver uses.
  const host = connectHost(url);
  if (host === undefined) return { event: { kind: 'db', driver: 'pg', target, owned: false }, env };

  // A Unix socket directory cannot be probed over TCP; the driver reports it if it is down.
  if (host.startsWith('/')) return { event: { kind: 'db', driver: 'pg', target, owned: false }, env };

  const port = url.port === '' ? 5432 : Number(url.port);
  // `new URL` keeps the brackets of an IPv6 host; a socket connect wants the bare address.
  const address = host.replace(/^\[(.*)\]$/, '$1');
  if (await probe(address, port, 1000)) return { event: { kind: 'db', driver: 'pg', target, owned: false }, env };

  const known = await loadServices();
  if (known === null) {
    return DevDbUnreachable({
      target,
      reason: `nothing listens on ${host}:${String(port)} and there is no compose file`,
    });
  }
  const service = known.find(entry => entry.name === host) ?? known.find(entry => entry.publishedPorts.includes(port));
  if (service === undefined) {
    return DevDbUnreachable({
      target,
      reason: `nothing listens on ${host}:${String(port)} and no compose service is named ${host} or publishes port ${String(port)}`,
    });
  }

  options.info?.(`dot dev ▸ db: starting compose service ${service.name}`);
  const up = await exec('docker', ['compose', 'up', '-d', service.name], { cwd: options.cwd });
  if (up.code !== 0) {
    const detail = up.stderr.trim().split('\n').at(-1) ?? '';
    return DevDbUnreachable({ target, reason: `docker compose up -d ${service.name} failed: ${detail}` });
  }
  const open = await pollUntil(() => probe(address, port, 1000), {
    intervalMs: options.pollIntervalMs ?? 500,
    timeoutMs: options.startTimeoutMs ?? 30_000,
    signal: options.signal,
  });
  if (!open) {
    return DevDbUnreachable({
      target,
      reason: `started compose service ${service.name}, but ${host}:${String(port)} did not open in time`,
    });
  }
  return { event: { kind: 'db', driver: 'pg', target, owned: true }, env };
}
