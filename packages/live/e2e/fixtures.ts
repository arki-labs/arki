/**
 * Worker fixtures: the fixture app's server, which a spec can kill and start
 * again (Playwright's `webServer` cannot); the network between the tabs and
 * that server, which a spec can cut; and a Postgres pool for commits that no
 * tab makes.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { test as base, expect } from '@playwright/test';
import pg from 'pg';

export { expect } from '@playwright/test';

export type AppServer = {
  readonly url: string;
  /** Starts the server and resolves once `/api/health` says its hub listens. */
  start(): Promise<void>;
  /** SIGKILL: a crash, not a shutdown. No `bye`; every connection just drops. */
  kill(): Promise<void>;
};

const serveScript = fileURLToPath(new URL('app/serve.ts', import.meta.url));

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL is not set: global-setup.ts did not run.');
  return url;
}

/** A port free now, kept for every restart: the tabs' origin must not change. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  probe.close();
  await once(probe, 'close');
  if (address === null || typeof address === 'string') throw new Error('could not read a free port');
  return address.port;
}

function appServer(port: number): AppServer {
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = '';
  const health = async (): Promise<number> => {
    try {
      const response = await fetch(`${url}/api/health`);
      return response.status;
    } catch {
      return 0;
    }
  };
  return {
    url,
    async start() {
      if (child !== undefined) throw new Error('the app server is already running');
      output = '';
      const started = spawn(
        'node',
        ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', serveScript],
        { env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl() }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child = started;
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      };
      started.stdout.on('data', keep);
      started.stderr.on('data', keep);
      try {
        await expect.poll(health, { timeout: 30_000 }).toBe(200);
      } catch (error) {
        throw new Error(`the app server did not become ready (exit code ${String(started.exitCode)}):\n${output}`, {
          cause: error,
        });
      }
    },
    async kill() {
      const running = child;
      child = undefined;
      if (running === undefined || running.exitCode !== null) return;
      const exited = once(running, 'exit');
      running.kill('SIGKILL');
      await exited;
    },
  };
}

export type Network = {
  /** What the tabs browse: the app server, through this network. */
  readonly url: string;
  /**
   * Resets every open connection, the way a real network loss reaches the browser. Chromium's
   * `context.setOffline(true)` alone only fails new requests: an open stream stays open.
   */
  dropConnections(): void;
};

/** A TCP proxy in front of the app server: the tabs' network, which a spec can cut. */
async function tcpProxy(targetPort: number): Promise<Network & { close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket, peer: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      peer.destroy();
    });
  };
  const proxy = createServer(client => {
    const upstream = connect(targetPort, '127.0.0.1');
    track(client, upstream);
    track(upstream, client);
    client.pipe(upstream).pipe(client);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('could not read the proxy port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    dropConnections: () => {
      for (const socket of sockets) socket.resetAndDestroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      await once(proxy, 'close');
    },
  };
}

/** A commit made outside every tab, the way another service or a migration would write. */
export async function insertPost(db: pg.Pool, title: string): Promise<void> {
  await db.query('insert into posts (id, title) values (gen_random_uuid()::text, $1)', [title]);
}

export const test = base.extend<object, { server: AppServer; network: Network; db: pg.Pool }>({
  db: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; it has none.
    async ({}, use) => {
      const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],
  server: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; it has none.
    async ({}, use) => {
      const server = appServer(await freePort());
      await server.start();
      await use(server);
      await server.kill();
    },
    { scope: 'worker' },
  ],
  network: [
    async ({ server }, use) => {
      const network = await tcpProxy(Number(new URL(server.url).port));
      await use(network);
      await network.close();
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ network }, use) => {
    await use(network.url);
  },
});
