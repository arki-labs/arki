/**
 * `e2eTest(...)` — the Playwright `test` for one app on its real stack.
 *
 * Per worker: its own database (a clone), its own Mailpit, and the built app server started with
 * that env. The same env boots the app graph a second time inside the Playwright worker, so a test
 * seeds data through the app's own services (`seed`) and signs users in (`actingAs`) without any
 * test-only route in the app.
 */
import { writeFile } from 'node:fs/promises';

import type {
  BrowserContext,
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
} from '@playwright/test';
import { test as base } from '@playwright/test';

import { getLogger } from '@arki/log';

import type { MailpitWorker, Mailbox, MailSummary, ReceivedMail } from '../services/mailpit.js';
import type { Json, ServiceSpec, Stack, WorkerValues } from '../stack/index.js';
import type { RunningServer, ServerOptions } from './server.js';
import { mailbox } from '../services/mailpit.js';
import { expect } from '../ai/playwright.js';
import { readManifest } from '../stack/index.js';
import { freePort, startServer } from './server.js';

const log = getLogger('arki:testing:e2e');

/** What a test needs from an app: boot the graph, read its services, dispose it. */
export type BootableApp<TServices> = {
  boot(): Promise<{ readonly services: TServices; dispose(): Promise<void> }>;
};

/** The sign-in seam of `@arki/auth`: a real session, as headers that carry its cookie. */
export type TestAuth<TUser> = {
  readonly testing: {
    signIn(user: { readonly email: string }): Promise<{ readonly headers: Headers; readonly user: TUser }>;
  };
};

/** A stack the e2e layer can use: it must have a `mailpit` service. */
export type E2EServices = Readonly<Record<string, ServiceSpec<Json, Json>>> & { readonly mailpit: ServiceSpec<null, MailpitWorker> };

/** One person in a test: a signed-in browser page and a view of their own mail. */
export type Actor<TUser> = {
  readonly email: string;
  readonly user: TUser;
  readonly page: Page;
  readonly mail: {
    /** Waits for a mail to this actor. */
    waitFor(match?: { readonly subject?: string | RegExp; readonly timeoutMs?: number }): Promise<ReceivedMail>;
    all(): Promise<readonly MailSummary[]>;
    clear(): Promise<void>;
  };
};

export type CronRun = { readonly status: number; readonly body: unknown };

type WorkerFixtures<M extends E2EServices, TServices> = {
  /** The running app server of this worker, the env it started with, and this worker's service values. */
  server: RunningServer & { readonly env: Readonly<Record<string, string>>; readonly values: WorkerValues<M> };
  /** The graph booted inside this worker. */
  graph: TServices;
  /** The app's services, from the graph booted inside this worker. */
  seed: TServices;
  mailbox: Mailbox;
};

type TestFixtures<TUser, TFactories> = {
  serverLog: undefined;
  actingAs(user?: { readonly email?: string }): Promise<Actor<TUser>>;
  cron: { run(name: string): Promise<CronRun> };
  factories: TFactories;
};

export type E2EOptions<M extends E2EServices, TServices, TUser, TFactories> = {
  readonly stack: Stack<M>;
  /** A loader, so the app's env is set before its modules read it. */
  readonly app: () => Promise<BootableApp<TServices>>;
  readonly auth: (services: TServices) => TestAuth<TUser>;
  readonly serve: ServerOptions['serve'];
  readonly factories: (services: TServices) => TFactories;
  /** The env name of the cron secret. Default `CRON_SECRET`. */
  readonly cronSecretEnv?: string;
};

type StoryArgs<M extends E2EServices, TServices, TUser, TFactories> = PlaywrightTestArgs &
  PlaywrightTestOptions &
  PlaywrightWorkerArgs &
  PlaywrightWorkerOptions &
  TestFixtures<TUser, TFactories> &
  WorkerFixtures<M, TServices>;

export function e2eTest<M extends E2EServices, TServices, TUser, TFactories>(
  options: E2EOptions<M, TServices, TUser, TFactories>,
) {
  const cronSecretEnv = options.cronSecretEnv ?? 'CRON_SECRET';

  const test = base.extend<TestFixtures<TUser, TFactories>, WorkerFixtures<M, TServices>>({
    graph: [
      async ({ server }, use) => {
        // The graph reads its env when it is imported and booted, so the env goes in first.
        Object.assign(process.env, server.env);
        const loaded = await options.app();
        const booted = await loaded.boot();
        await use(booted.services);
        await booted.dispose();
      },
      { scope: 'worker' },
    ],
    server: [
      // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from the destructured first argument
      async ({}, use, workerInfo) => {
        const slice = await options.stack.attach(readManifest()).worker(workerInfo.parallelIndex);
        const port = await freePort();
        const env = slice.envFor(`http://localhost:${port}`);
        const started = performance.now();
        const running = await startServer({ serve: options.serve, env, port });
        log.debug('Server of worker {worker} ready in {ms} ms', {
          worker: workerInfo.parallelIndex,
          ms: Math.round(performance.now() - started),
        });
        await use(Object.assign(running, { env, values: slice.values }));
        await running.stop();
        await slice.stop();
      },
      { scope: 'worker' },
    ],
    seed: [async ({ graph }, use) => use(graph), { scope: 'worker' }],
    mailbox: [async ({ server }, use) => use(mailbox(server.values.mailpit.httpUrl)), { scope: 'worker' }],
    // A failed test carries what its server printed, which is where a 500 explains itself.
    serverLog: [
      async ({ server }, use, testInfo) => {
        // eslint-disable-next-line unicorn/no-useless-undefined -- Playwright types a void fixture's `use` as taking one argument
        await use(undefined);
        if (testInfo.status !== testInfo.expectedStatus) {
          const path = testInfo.outputPath('server.log');
          await writeFile(path, server.logs());
          await testInfo.attach('server.log', { path });
        }
      },
      { auto: true },
    ],
    baseURL: async ({ server }, use) => use(server.url),
    factories: async ({ seed }, use) => use(options.factories(seed)),
    cron: async ({ server, request }, use) => {
      const secret = server.env[cronSecretEnv];
      if (secret === undefined) throw new Error(`CRON_SECRET_MISSING: the stack env must set ${cronSecretEnv}.`);
      await use({
        async run(name) {
          const response = await request.post(`/api/cron/${name}`, { headers: { authorization: `Bearer ${secret}` } });
          const text = await response.text();
          const body: unknown = text === '' ? null : JSON.parse(text);
          if (!response.ok()) throw new Error(`CRON_FAILED: ${name} answered ${response.status()}: ${text}`);
          return { status: response.status(), body };
        },
      });
    },
    actingAs: async ({ seed, context, mailbox: box, server }, use) => {
      await use(async user => {
        const email = (user?.email ?? `actor-${Math.random().toString(36).slice(2, 8)}@e2e.test`).toLowerCase();
        const signed = await options.auth(seed).testing.signIn({ email });
        await addSessionCookie(context, signed.headers, server.url);
        const page = await context.newPage();
        return {
          email,
          user: signed.user,
          page,
          mail: {
            waitFor: match => box.waitFor({ to: email, ...match }),
            all: () => box.all(email),
            clear: () => box.clear(email),
          },
        };
      });
    },
  });

  /** A test that proves one user story. The title starts with the id, so the report and the PRD agree. */
  function story(
    id: string,
    title: string,
    body: (
      args: StoryArgs<M, TServices, TUser, TFactories>,
      testInfo: TestInfo,
    ) => Promise<void> | void,
  ) {
    return test(`${id}: ${title}`, { annotation: { type: 'story', description: id }, tag: ['@story'] }, body);
  }

  return { test, expect, story };
}

/** `name=value` from a `cookie` header, installed on the browser context for the server's host. */
async function addSessionCookie(context: BrowserContext, headers: Headers, serverUrl: string): Promise<void> {
  const header = headers.get('cookie');
  if (header === null) throw new Error('SESSION_COOKIE_MISSING: auth.testing.signIn returned no cookie.');
  const cookies = header.split(';').map(part => {
    const at = part.indexOf('=');
    return { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim(), url: serverUrl };
  });
  await context.addCookies(cookies);
}



export {type WorkerValues} from '../stack/index.js';