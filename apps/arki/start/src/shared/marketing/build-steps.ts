/**
 * The build path on the homepage: six steps, foundation first, and the real code each one shows.
 * Every excerpt names its file and its first line. `e2e/home.spec.ts` opens each file and checks that every line is
 * exactly where this data says it is, so a refactor of the source breaks the test and not the reader.
 */

import type { Excerpt } from './excerpt';
import {
  CLAIM_RECEIPT,
  JOURNAL_HEADLINE,
  ORDER_ENTITY,
  ORDER_REDUCERS,
  PAY_ORDER,
  REFUND_STEPS,
  WRITE_ORDER,
} from './journal-excerpts';
import { MODEL_EXCERPTS } from './model-excerpts';

const APP_FILE = 'apps/avocabo/backend/src/app.ts';
const DOT_README = 'packages/dot/README.md';
const QUICKSTART_FILE = 'packages/dot/docs/quickstart.md';
const QUICKSTART_APP = 'packages/dot/docs/examples/quickstart.ts';
const QUICKSTART_WRONG = 'packages/dot/docs/examples/quickstart-wrong-order.mjs';
const WAITLIST = 'apps/avocabo/backend/src/features/waitlist';
const FEATURES_FILE = 'apps/avocabo/backend/src/features.ts';
const SERVER_FILE = 'apps/avocabo/start/src/server.ts';
const UNSUBSCRIBE_ROUTE = 'apps/avocabo/start/src/routes/waitlist/unsubscribe.tsx';

/** The whole idea in one runnable file: a unit, the chain that starts it, and the shutdown. */
export const DEFINE_UNIT = {
  note: 'the quick start, runnable',
  parts: [
    {
      id: 'imports',
      path: DOT_README,
      from: 33,
      imports: true,
      lines: ["import { defineApp, infra } from '@arki/dot';"],
    },
    {
      id: 'unit',
      path: DOT_README,
      from: 41,
      lines: [
        'const database = infra({',
        "  name: 'database',",
        '  provides: {',
        '    db: () => openDb(process.env.DATABASE_URL), // ← one factory per key; may be async',
        '  },',
        '  async dispose({ db }) {',
        '    await db.close();',
        '  },',
        '});',
      ],
    },
    {
      id: 'start',
      path: DOT_README,
      from: 72,
      lines: [
        "const app = await defineApp('pizzeria')",
        '  .infra(database, stripe) // providers before consumers — enforced at compile time',
        '  .start();',
      ],
    },
    {
      id: 'stop',
      path: DOT_README,
      from: 81,
      lines: ['await app.stop();', 'await app.dispose();'],
    },
  ],
} as const satisfies Excerpt;

export const DEFINE_APP = {
  note: 'a real app',
  parts: [
    {
      id: 'import-dot',
      path: APP_FILE,
      from: 16,
      imports: true,
      lines: ["import { defineApp, logHandlers, token } from '@arki/dot';"],
    },
    {
      id: 'import-start',
      path: APP_FILE,
      from: 18,
      imports: true,
      lines: ["import { tanstackStart } from '@arki/tanstack-start/dot';"],
    },
    {
      id: 'import-features',
      path: APP_FILE,
      from: 21,
      imports: true,
      lines: ["import { features } from './features';"],
    },
    {
      id: 'import-units',
      path: APP_FILE,
      from: 23,
      imports: true,
      lines: [
        "import { sentryErrors } from './entrypoints/middleware';",
        "import { gateway } from './entrypoints/gateway';",
        "import { database } from './infra/db';",
        "import { cache } from './infra/kv';",
        "import { authn } from './infra/auth';",
        "import { audioStorage } from './infra/audio-storage';",
        "import { locking } from './infra/locks';",
        "import { appMail, emailClient } from './infra/mail/client';",
        "import { embedding, vectorErasure, vectors } from './infra/vectors/vectors';",
      ],
    },
    {
      id: 'app',
      path: APP_FILE,
      from: 42,
      lines: [
        "export const app = defineApp('avocabo', { observers: [sentryErrors, logHandlers()] })",
        '  .infra(database, cache, appMail, emailClient, authn, locking, embedding, vectors, vectorErasure, audioStorage)',
        '  .features(features)',
        '  .entrypoints(',
        '    hostClock,',
        '    gateway,',
        '    tanstackStart({',
      ],
    },
    { id: 'end', path: APP_FILE, from: 65, lines: ['    }),', '  );'] },
  ],
} as const satisfies Excerpt;

/** Two units that need `db`: the session store and the orders feature of the quickstart app. */
export const WIRE_UNITS = {
  note: 'two units that need db',
  parts: [
    {
      id: 'imports',
      path: QUICKSTART_APP,
      from: 9,
      imports: true,
      lines: ["import { defineApp, infra } from '@arki/dot';", "import { defineFeature } from '@arki/dot/feature';"],
    },
    {
      id: 'sessions',
      path: QUICKSTART_APP,
      from: 32,
      lines: [
        'export const sessions = infra({',
        "  name: 'sessions',",
        '  needs: { db: database.provides.db }, // the handle, not a string: a typo cannot compile',
      ],
    },
    {
      id: 'orders',
      path: QUICKSTART_APP,
      from: 47,
      lines: ["export const orders = defineFeature('orders')", '  .needs({ db: database.provides.db })'],
    },
  ],
} as const satisfies Excerpt;

/** The line the reader swaps: `.infra(sessions, database)` is the part the compiler refuses. */
export const WIRE_MISTAKE = {
  note: 'the mistake',
  parts: [
    {
      id: 'import-dot',
      path: QUICKSTART_WRONG,
      from: 8,
      imports: true,
      lines: ["import { defineApp } from '@arki/dot';"],
    },
    {
      id: 'import-units',
      path: QUICKSTART_WRONG,
      from: 10,
      imports: true,
      lines: ["import { database, orders, sessions } from './quickstart.js';"],
    },
    {
      id: 'wrong-order',
      path: QUICKSTART_WRONG,
      from: 13,
      lines: ["export default defineApp('shop').infra(sessions, database).features([orders]);"],
    },
  ],
} as const satisfies Excerpt;

/** The piece of the mistake the compiler points at. */
export const WIRE_MISTAKE_MARK = '.infra(sessions, database)';

export const WIRE_FIX = {
  parts: [
    {
      id: 'imports',
      path: QUICKSTART_APP,
      from: 9,
      imports: true,
      lines: ["import { defineApp, infra } from '@arki/dot';"],
    },
    {
      id: 'right-order',
      path: QUICKSTART_APP,
      from: 63,
      lines: ["export default defineApp('shop').infra(database, sessions).features([orders]);"],
    },
  ],
} as const satisfies Excerpt;

/** The type error, as the quickstart prints it: the guard's name, then the need nothing provides yet. */
export const WIRE_ERROR = {
  path: QUICKSTART_FILE,
  from: 115,
  lines: [
    "Property ''DOT: a unit in this list cannot be mounted at its position'' is missing in type ...",
    '  ... NeedsError<EmptyShape, WireNeeds<{ db: Handle<..., "db", "database">; }>> ...',
  ],
} as const;

/** The type that makes the compiler say it: `define-app.ts` holds the message as a property name. */
export const WIRE_ERROR_SOURCE = {
  path: 'packages/dot/src/define-app.ts',
  message: 'DOT: a unit in this list cannot be mounted at its position',
} as const;

/** The app's one feature list: a feature joins the app with one line here. */
export const FEATURE_LIST = {
  note: 'one line per feature',
  parts: [
    { id: 'import', path: FEATURES_FILE, from: 48, lines: ["import { waitlist } from './features/waitlist/feature';"] },
    { id: 'list', path: FEATURES_FILE, from: 53, lines: ['export const features = [', '  health,'] },
    { id: 'waitlist', path: FEATURES_FILE, from: 74, lines: ['  waitlist,'] },
    { id: 'end', path: FEATURES_FILE, from: 84, lines: ['] as const;'] },
  ],
} as const satisfies Excerpt;

export const FEATURE_NEEDS = {
  parts: [
    {
      id: 'import-dot',
      path: `${WAITLIST}/feature.ts`,
      from: 11,
      imports: true,
      lines: ["import { defineFeature, entrypointOnly } from '@arki/dot/feature';"],
    },
    {
      id: 'import-app',
      path: `${WAITLIST}/feature.ts`,
      from: 15,
      imports: true,
      lines: [
        "import { database } from '../../infra/db';",
        "import { cache } from '../../infra/kv';",
        "import { emailClient } from '../../infra/mail/client';",
      ],
    },
    {
      id: 'import-own',
      path: `${WAITLIST}/feature.ts`,
      from: 20,
      imports: true,
      lines: [
        "import { limiter } from './infra/signup-limiter';",
        "import { store } from './infra/store';",
        "import { turnstile } from './infra/turnstile';",
      ],
    },
    {
      id: 'needs',
      path: `${WAITLIST}/feature.ts`,
      from: 30,
      lines: [
        "const waitlistDeps = defineFeature('waitlist')",
        '  // The store binds `db`, the signup limiter binds `kv`; usecases never see them.',
        '  .needs({',
        '    db: entrypointOnly(database.provides.db),',
        '    kv: entrypointOnly(cache.provides.kv),',
        "    // The app's outbound email client; a test fakes the plugin.",
        '    mailer: emailClient.provides.emailClient,',
        '  })',
        '  .infra(store, limiter, turnstile);',
      ],
    },
  ],
} as const satisfies Excerpt;

/** A whole usecase: it picks `repos` by key and never sees the database. */
export const FEATURE_USECASE = {
  parts: [
    {
      id: 'imports',
      path: `${WAITLIST}/usecases/public-count.ts`,
      from: 1,
      imports: true,
      lines: ["import type { Deps } from '../feature';"],
    },
    {
      id: 'usecase',
      path: `${WAITLIST}/usecases/public-count.ts`,
      from: 7,
      lines: [
        'export const publicCount =',
        "  ({ repos: { entries } }: Pick<Deps, 'repos'>) =>",
        '  async () => {',
        '    const [pending, invited, activated] = await Promise.all([',
        "      entries.countByStatus('pending'),",
        "      entries.countByStatus('invited'),",
        "      entries.countByStatus('activated'),",
        '    ]);',
        '    return { total: pending + invited + activated };',
        '  };',
      ],
    },
  ],
} as const satisfies Excerpt;

/** The process's front door: one call starts the app and hands every request to TanStack Start. */
export const SERVE_SERVER = {
  parts: [
    {
      id: 'import-app',
      path: SERVER_FILE,
      from: 9,
      imports: true,
      lines: [
        "import { app } from '@avocabo/backend/app';",
        "import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';",
      ],
    },
    {
      id: 'import-server',
      path: SERVER_FILE,
      from: 16,
      imports: true,
      lines: [
        "import { startServer } from '@arki/tanstack-start/server';",
        "import { withServerErrorOverlay } from '@arki/tanstack-start/server-error-overlay';",
      ],
    },
    { id: 'import-env', path: SERVER_FILE, from: 19, imports: true, lines: ["import { env } from '~/env';"] },
    {
      id: 'serve',
      path: SERVER_FILE,
      from: 47,
      lines: [
        'export const server = startServer(app, {',
        '  hot: import.meta.hot,',
        "  eager: env.NODE_ENV === 'production',",
        '  handler: withServerErrorOverlay(createStartHandler(defaultStreamHandler)),',
        '});',
      ],
    },
  ],
} as const satisfies Excerpt;

export const SERVE_APP = {
  parts: [
    {
      id: 'import-start',
      path: APP_FILE,
      from: 18,
      imports: true,
      lines: ["import { tanstackStart } from '@arki/tanstack-start/dot';"],
    },
    {
      id: 'import-gateway',
      path: APP_FILE,
      from: 24,
      imports: true,
      lines: ["import { gateway } from './entrypoints/gateway';"],
    },
    { id: 'import-auth', path: APP_FILE, from: 27, imports: true, lines: ["import { authn } from './infra/auth';"] },
    {
      id: 'serve',
      path: APP_FILE,
      from: 48,
      lines: [
        '    tanstackStart({',
        '      needs: { rpc: gateway.provides.rpc, auth: authn.provides.auth, scheduler },',
        '      session: ({ auth }, request) => auth.principal(request.headers),',
        '      rpc: ({ rpc }, request) => rpc.client(request.headers),',
      ],
    },
  ],
} as const satisfies Excerpt;

/** A Start route that calls a service the waitlist feature provides, through the request context. */
export const SERVE_ROUTE = {
  parts: [
    {
      id: 'import-router',
      path: UNSUBSCRIBE_ROUTE,
      from: 1,
      imports: true,
      lines: ["import { createFileRoute } from '@tanstack/react-router';"],
    },
    {
      id: 'import-failure',
      path: UNSUBSCRIBE_ROUTE,
      from: 3,
      imports: true,
      lines: ["import { orThrow } from '@arki/failure';"],
    },
    {
      id: 'route',
      path: UNSUBSCRIBE_ROUTE,
      from: 38,
      lines: [
        "export const Route = createFileRoute('/waitlist/unsubscribe')({",
        '  server: {',
        '    handlers: {',
        '      GET: async ({ request, context }) => {',
      ],
    },
    {
      id: 'services',
      path: UNSUBSCRIBE_ROUTE,
      from: 53,
      lines: [
        '          const { waitlistUnsubscribe } = context.services;',
        '          const outcome = orThrow(await waitlistUnsubscribe.byToken(token));',
      ],
    },
  ],
} as const satisfies Excerpt;

/** `dot explain` on the quickstart app, and what it printed: every unit, what it needs, what it provides. */
export const EXPLAIN_COMMAND = {
  note: 'the command, then its real output',
  parts: [
    {
      id: 'explain',
      path: QUICKSTART_FILE,
      from: 169,
      lines: ["dot explain --app src/app.ts --json | jq -c '.data.plugins[], .data.dependencies[]'"],
    },
    {
      id: 'output',
      path: QUICKSTART_FILE,
      from: 191,
      lines: [
        '{"name":"database","role":"infra","dependencies":[],"provides":["db"]}',
        '{"name":"sessions","role":"infra","dependencies":["db"],"provides":["sessions"]}',
        '{"name":"orders","role":"feature","dependencies":["db"],"provides":["orders.usecases","orders.services","feature.orders","orders"]}',
        '{"from":"sessions","to":"database","kind":"requires","key":"db"}',
        '{"from":"orders","to":"database","kind":"requires","key":"db"}',
      ],
    },
  ],
} as const satisfies Excerpt;

/** `dot doctor` on the same app: it boots every unit, reports each one, and shuts the app down. */
export const DOCTOR_COMMAND = {
  note: 'the command, then its real output',
  parts: [
    {
      id: 'doctor',
      path: QUICKSTART_FILE,
      from: 207,
      lines: [
        "dot doctor --app src/app.ts --json | jq -c '.data.status, (.data.plugins[] | {plugin, status}), .data.issues'",
      ],
    },
    {
      id: 'output',
      path: QUICKSTART_FILE,
      from: 232,
      lines: [
        '"success"',
        '{"plugin":"database","status":"ok"}',
        '{"plugin":"sessions","status":"ok"}',
        '{"plugin":"orders","status":"ok"}',
        '[]',
      ],
    },
  ],
} as const satisfies Excerpt;

/**
 * The first lines of what `dot explain --app src/app.ts --graph` printed for avocabo's app (apps/avocabo/backend,
 * prelaunch, built with arki). The command prints Mermaid flowchart source; the full graph is 449 lines. The lines are
 * cut at a whole line and are not edited.
 */
export const EXPLAIN_GRAPH_OUTPUT = {
  command: 'dot explain --app src/app.ts --graph',
  lines: [
    'flowchart TD',
    '  %% numbers = boot order',
    '  subgraph infra["infra · what features need"]',
    '    p0["1 · db"]',
    '    p1["2 · kv"]',
    '    p2["3 · mail"]',
    '    p3["4 · email-client"]',
    '    p4["5 · auth"]',
    '    p5["6 · locks"]',
    '    p7["8 · vector-index/embeddings"]',
    '    p8["9 · vector-index/vectorIndex"]',
    '    p10["11 · account/repos"]',
    '    p11["12 · account/outboundMail"]',
    '    p13["14 · billing/repos"]',
    '…',
  ],
} as const;

/** A test boots the real app before the tests and disposes it after them. */
export const START_IN_TEST = {
  parts: [
    {
      id: 'import-vitest',
      path: 'demos/faultline/backend/src/delivery.test.ts',
      from: 1,
      imports: true,
      lines: ["import { afterAll, beforeAll, describe, expect, it } from 'vitest';"],
    },
    {
      id: 'import-arki',
      path: 'demos/faultline/backend/src/delivery.test.ts',
      from: 4,
      imports: true,
      lines: ["import { isFailure, orThrow } from '@arki/failure';", "import { listen } from '@arki/http';"],
    },
    {
      id: 'import-app',
      path: 'demos/faultline/backend/src/delivery.test.ts',
      from: 10,
      imports: true,
      lines: ["import { app } from './app';"],
    },
    {
      id: 'import-hooks',
      path: 'demos/faultline/backend/src/delivery.test.ts',
      from: 14,
      imports: true,
      lines: ["import { hooksEngine } from './hooks';"],
    },
    {
      id: 'start',
      path: 'demos/faultline/backend/src/delivery.test.ts',
      from: 24,
      lines: [
        'beforeAll(async () => {',
        '  started = orThrow(await app.start());',
        "  // The worker's HTTP calls (reports, partner webhook, mail provider) reach this server (WEB_ORIGIN).",
        "  server = await listen(hooksEngine(started.services.db), { port: 3576, hostname: '127.0.0.1' });",
        '});',
        '',
        'afterAll(async () => {',
        '  server.forceClose();',
        '  await started.dispose();',
        '});',
      ],
    },
  ],
} as const satisfies Excerpt;

/** Every excerpt on the page, for the test that opens the files. */
export const ALL_EXCERPTS = [
  DEFINE_UNIT,
  DEFINE_APP,
  WIRE_UNITS,
  WIRE_MISTAKE,
  WIRE_FIX,
  FEATURE_LIST,
  FEATURE_NEEDS,
  FEATURE_USECASE,
  ORDER_ENTITY,
  PAY_ORDER,
  WRITE_ORDER,
  CLAIM_RECEIPT,
  ORDER_REDUCERS,
  REFUND_STEPS,
  SERVE_SERVER,
  SERVE_APP,
  SERVE_ROUTE,
  EXPLAIN_COMMAND,
  DOCTOR_COMMAND,
  START_IN_TEST,
  ...MODEL_EXCERPTS,
] as const satisfies readonly Excerpt[];

/** The names of the steps, foundation first. One list feeds the type and the order. */
export const STEP_IDS = ['define', 'wire', 'feature', 'remember', 'serve', 'inspect'] as const;

export type BuildStep = {
  id: (typeof STEP_IDS)[number];
  /** "F1": the floor number, bottom first. */
  number: string;
  /** The verb, also the floor's name in the elevation drawing. */
  verb: string;
  kicker: string;
  title: string;
  /** A full drawing sheet that opens on this floor, drawn on the elevation as a tag. */
  sheet?: string;
  /** One arch in the elevation for each excerpt a reader can see on this floor. */
  excerpts: readonly Excerpt[];
};

const STEP_LIST = [
  {
    id: 'define',
    number: 'F1',
    verb: 'Define',
    kicker: 'what a Dot app is',
    title: 'Read one chain. That is the whole app.',
    excerpts: [DEFINE_UNIT, DEFINE_APP],
  },
  {
    id: 'wire',
    number: 'F2',
    verb: 'Wire',
    kicker: 'the compiler checks the order',
    title: 'Put a unit before what it needs. It will not compile.',
    sheet: 'A-101',
    excerpts: [WIRE_UNITS, WIRE_MISTAKE, WIRE_FIX],
  },
  {
    id: 'feature',
    number: 'F3',
    verb: 'Feature',
    kicker: 'model · usecases · infra · entrypoints',
    title: 'Open a feature and read what your product does. The plumbing waits outside.',
    excerpts: [FEATURE_LIST, FEATURE_NEEDS, FEATURE_USECASE],
  },
  {
    id: 'remember',
    number: 'F4',
    verb: 'Remember',
    kicker: '@arki/journal · five things you can try',
    title: JOURNAL_HEADLINE,
    sheet: 'J-100',
    excerpts: [ORDER_ENTITY, PAY_ORDER, WRITE_ORDER, CLAIM_RECEIPT, ORDER_REDUCERS, REFUND_STEPS],
  },
  {
    id: 'serve',
    number: 'F5',
    verb: 'Serve',
    kicker: 'TanStack Start',
    title: 'One call serves the app. Every route gets its services, typed.',
    excerpts: [SERVE_SERVER, SERVE_APP, SERVE_ROUTE],
  },
  {
    id: 'inspect',
    number: 'F6',
    verb: 'Inspect',
    kicker: 'and test',
    title: 'See every unit before it runs. Then start the real app in a test.',
    excerpts: [EXPLAIN_COMMAND, DOCTOR_COMMAND, START_IN_TEST],
  },
] as const satisfies readonly BuildStep[];

export const BUILD_STEPS: readonly BuildStep[] = STEP_LIST;

export const [DEFINE_STEP, WIRE_STEP, FEATURE_STEP, REMEMBER_STEP, SERVE_STEP, INSPECT_STEP] = STEP_LIST;

/** The four rooms of a feature, as the design draws them. */
export const FEATURE_ROOMS = [
  { name: 'model', text: 'the things and their rules' },
  { name: 'usecases', text: 'what someone can do' },
  { name: 'infra', text: 'how it talks to the outside' },
  { name: 'entrypoints', text: 'how a request gets in' },
] as const;

type Wave = { name: string; title: string; packages: readonly string[] };

/**
 * The materials strip. Every name must be in `src/generated/packages.json` and a folder under `packages/`; the e2e
 * test checks both. Left out on purpose: `expr`, `cas` and `bench` (never marketed) and `react-hooks` (folded into
 * `@arki/ui`).
 */
export const WAVES = [
  {
    name: 'Foundation',
    title: 'Validate input. Return failures as values.',
    packages: ['schema', 'failure', 'contracts', 'log', 'ts', 'date', 'string', 'clock', 'math', 'async'],
  },
  { name: 'DOT Kernel', title: 'Compose packages into an app.', packages: ['cli', 'dot', 'env', 'resilience'] },
  {
    name: 'Infrastructure',
    title: 'Connect Postgres, queues, mail and sign-in.',
    packages: ['db', 'kv', 'http', 'journal', 'live', 'lock', 'mail', 'auth'],
  },
  {
    name: 'Frontend',
    title: 'Put a React interface on it.',
    packages: ['icons', 'ui'],
  },
  { name: 'Specialized', title: 'Handle money and payments.', packages: ['money', 'payments'] },
] as const satisfies readonly Wave[];
