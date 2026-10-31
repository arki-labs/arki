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
  TestInfo,
} from '@playwright/test';
import { test as base } from '@playwright/test';
import type { TestType } from '@playwright/test';

import { orThrow } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { MailpitWorker, Mailbox, MailSummary, ReceivedMail } from '../services/mailpit.js';
import type { Json, ServiceSpec, Stack, WorkerValues } from '../stack/index.js';
import type { RunningServer, ServerOptions } from './server.js';
import { mailbox } from '../services/mailpit.js';
import { truncateAll } from '../services/postgres.js';
import { flushRedis } from '../services/redis.js';
import { expect } from '../ai/playwright.js';
import { readManifest } from '../stack/index.js';
import { serveWorker } from './server.js';

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

/**
 * What a test shares with the ones before it on the same worker.
 * `shared` (default): the worker's database, mail and keys as the last test left them.
 * `fresh`: every table emptied, mail and keys flushed before the test starts. Use it for a test
 * that runs work over everything in the database (a global cron), whose outcome would otherwise
 * depend on the tests that ran before it. Set it with `test.use({ isolation: 'fresh' })`.
 */
export type Isolation = 'shared' | 'fresh';

type TestFixtures<TUser, TFactories> = {
  isolation: Isolation;
  /** Runs first (it is automatic): puts the worker in the state `isolation` asks for. */
  freshWorker: undefined;
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
        await serveWorker({
          stack: options.stack.attach(orThrow(readManifest())),
          workerIndex: workerInfo.parallelIndex,
          serve: options.serve,
          use,
        });
      },
      { scope: 'worker' },
    ],
    seed: [async ({ graph }, use) => use(graph), { scope: 'worker' }],
    isolation: ['shared', { option: true }],
    freshWorker: [
      async ({ isolation, server, mailbox: box }, use, testInfo) => {
        if (isolation === 'fresh') {
          const started = performance.now();
          const database = urlOf(server.values, 'postgres');
          const keys = urlOf(server.values, 'redis');
          await Promise.all([
            database === undefined ? undefined : truncateAll(database),
            keys === undefined ? undefined : flushRedis(keys),
            box.clear(),
          ]);
          const ms = Math.round(performance.now() - started);
          log.debug('Fresh isolation of worker {worker} took {ms} ms', { worker: testInfo.parallelIndex, ms });
          testInfo.annotations.push({ type: 'fresh-isolation', description: `${ms} ms` });
        }
        // eslint-disable-next-line unicorn/no-useless-undefined -- Playwright types a void fixture's `use` as taking one argument
        await use(undefined);
      },
      { auto: true },
    ],
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
    factories: async ({ seed, freshWorker }, use) => {
      void freshWorker;
      await use(options.factories(seed));
    },
    cron: async ({ server, request, freshWorker }, use) => {
      void freshWorker;
      const secret = server.env[cronSecretEnv];
      if (secret === undefined) throw new Error(`CRON_SECRET_MISSING: the stack env must set ${cronSecretEnv}.`);
      await use({
        async run(name) {
          const response = await request.post(`/api/cron/${name}`, { headers: { authorization: `Bearer ${secret}` }, timeout: 0 });
          const text = await response.text();
          const body: unknown = text === '' ? null : JSON.parse(text);
          if (!response.ok()) throw new Error(`CRON_FAILED: ${name} answered ${response.status()}: ${text}`);
          return { status: response.status(), body };
        },
      });
    },
    actingAs: async ({ seed, context, browser, mailbox: box, server, freshWorker }, use) => {
      void freshWorker;
      // The test's own browser context serves the first actor. A second actor needs a context of
      // their own, or their session cookie would replace the first one's.
      const extra: BrowserContext[] = [];
      let actors = 0;
      await use(async user => {
        const email = (user?.email ?? `actor-${Math.random().toString(36).slice(2, 8)}@e2e.test`).toLowerCase();
        const signed = await options.auth(seed).testing.signIn({ email });
        const own = actors === 0 ? context : await browser.newContext({ baseURL: server.url });
        if (actors > 0) extra.push(own);
        actors += 1;
        await addSessionCookie(own, signed.headers, server.url);
        const page = await own.newPage();
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
      for (const closing of extra) await closing.close();
    },
  });

  const story = storyFor(test);

  return { test, expect, story };
}

/** The `url` a service published for this worker, when the stack has that service. */
function urlOf(values: object, service: string): string | undefined {
  const published: unknown = Reflect.get(values, service);
  if (typeof published !== 'object' || published === null) return undefined;
  const url: unknown = Reflect.get(published, 'url');
  return typeof url === 'string' ? url : undefined;
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
/** What a story body receives from a test built by `e2eTest`, plus whatever the app added with `extend`. */
export type StoryBody<TArgs extends object, WArgs extends object> = (
  args: TArgs & WArgs,
  testInfo: TestInfo,
) => Promise<void> | void;

/**
 * `story(id, title, body)` for any Playwright test, including one an app extended with its own
 * fixtures. The title starts with the id, so the report and the PRD agree.
 */
export function storyFor<TArgs extends object, WArgs extends object>(test: TestType<TArgs, WArgs>) {
  function story(id: string, title: string, body: StoryBody<TArgs, WArgs>): void;
  /** `tag` adds to `@story`, so a project can pick this story out by tag. */
  function story(id: string, title: string, details: { readonly tag: string }, body: StoryBody<TArgs, WArgs>): void;
  function story(
    id: string,
    title: string,
    detailsOrBody: { readonly tag: string } | StoryBody<TArgs, WArgs>,
    maybeBody?: StoryBody<TArgs, WArgs>,
  ): void {
    const [extraTag, body] =
      typeof detailsOrBody === 'function' ? [undefined, detailsOrBody] : [detailsOrBody.tag, maybeBody];
    if (body === undefined) throw new Error(`STORY_BODY_MISSING: story ${id} has no body.`);
    test(
      `${id}: ${title}`,
      { annotation: { type: 'story', description: id }, tag: extraTag === undefined ? ['@story'] : ['@story', extraTag] },
      body,
    );
  }
  return story;
}
