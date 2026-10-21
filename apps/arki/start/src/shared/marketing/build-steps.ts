/**
 * The build path on the homepage: six steps, foundation first, and the real code each one shows.
 * Every excerpt names its file and its first line. `e2e/home.spec.ts` opens each file and checks that every line is
 * exactly where this data says it is, so a refactor of the source breaks the test and not the reader.
 */

/** A run of consecutive lines copied from one file. */
export type ExcerptPart = {
  /** Names the part, so a stepper can light it. */
  id: string;
  /** The file, relative to the workspace root. */
  path: string;
  /** The line number, in that file, of the first line. */
  from: number;
  lines: readonly string[];
};

/** Parts shown one after another. A gap between parts of one file is drawn as a blank line. */
export type Excerpt = {
  /** What the reader should notice, added to the caption. */
  note?: string;
  parts: readonly ExcerptPart[];
};

type LineRange = { from: number; to: number };
type CaptionGroup = { path: string; ranges: LineRange[] };

const range = ({ from, to }: LineRange) => (from === to ? `${from}` : `${from}–${to}`);

/** "path · lines 39–42", with one range per run of lines and one group per file. */
export function excerptCaption({ note, parts }: Excerpt): string {
  const groups: CaptionGroup[] = [];
  for (const part of parts) {
    const to = part.from + part.lines.length - 1;
    const group = groups.at(-1);
    if (group === undefined || group.path !== part.path) {
      groups.push({ path: part.path, ranges: [{ from: part.from, to }] });
      continue;
    }
    const last = group.ranges.at(-1);
    if (last !== undefined && last.to + 1 === part.from) last.to = to;
    else group.ranges.push({ from: part.from, to });
  }
  const files = groups.map(({ path, ranges }) => {
    const count = ranges.reduce((sum, { from, to }) => sum + (to - from + 1), 0);
    return `${path} · ${count === 1 ? 'line' : 'lines'} ${ranges.map(item => range(item)).join(', ')}`;
  });
  return [...files, ...(note === undefined ? [] : [note])].join(' · ');
}

const APP_FILE = 'apps/avocabo/backend/src/app.ts';
const QUICKSTART_FILE = 'packages/dot/docs/quickstart.md';
const WAITLIST = 'apps/avocabo/backend/src/features/waitlist';
const README_FILE = 'packages/journal/README.md';
const REFUND_WORKFLOW_FILE = 'packages/payments/src/refunds/workflow.ts';

export const DEFINE_APP = {
  parts: [
    {
      id: 'app',
      path: APP_FILE,
      from: 39,
      lines: [
        "export const app = defineApp('avocabo')",
        '  .infra(database, cache, appMail, emailClient, authn, locking)',
        '  .features([...features, gateway])',
        '  .entrypoints(',
      ],
    },
  ],
} as const satisfies Excerpt;

/** The line the reader swaps: `.use(orders)` is the part the compiler refuses. */
export const WIRE_MISTAKE = {
  note: 'the mistake',
  parts: [
    {
      id: 'wrong-order',
      path: QUICKSTART_FILE,
      from: 76,
      lines: ["export default defineApp('shop').use(orders).use(database);"],
    },
  ],
} as const satisfies Excerpt;

/** The piece of the mistake the compiler points at. */
export const WIRE_MISTAKE_MARK = '.use(orders)';

export const WIRE_FIX = {
  parts: [
    {
      id: 'right-order',
      path: QUICKSTART_FILE,
      from: 64,
      lines: ["export default defineApp('shop').use(database).use(orders);"],
    },
  ],
} as const satisfies Excerpt;

/** The last line of the type error, as the quickstart prints it. */
export const WIRE_ERROR = {
  path: QUICKSTART_FILE,
  line: 83,
  text: "Property ''DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.use → .features → .serve)'' is missing in type ...",
} as const;

/** The type that makes the compiler say it: `define-app.ts` holds the message as a property name. */
export const WIRE_ERROR_SOURCE = {
  path: 'packages/dot/src/define-app.ts',
  message:
    'DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.use → .features → .serve)',
} as const;

export const FEATURE_NEEDS = {
  parts: [
    {
      id: 'needs',
      path: `${WAITLIST}/feature.ts`,
      from: 32,
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

export const FEATURE_USECASE = {
  parts: [
    {
      id: 'usecase',
      path: `${WAITLIST}/usecases/signup.ts`,
      from: 68,
      lines: [
        'export const signup =',
        "  ({ repos, signupLimiter, turnstile, mailer }: Pick<Deps, 'repos' | 'signupLimiter' | 'turnstile' | 'mailer'>) =>",
      ],
    },
  ],
} as const satisfies Excerpt;

/** `@arki/journal` README, lines 81–90. Each part is a line a stepper can light. */
export const PAY_ORDER = {
  parts: [
    {
      id: 'head',
      path: README_FILE,
      from: 81,
      lines: [
        'export const payOrder = j.command(',
        "  'payOrder',",
        '  z.object({ orderId: orderIdSchema, amount: z.int().positive() }),',
        '  (input, { write }) =>',
      ],
    },
    { id: 'write', path: README_FILE, from: 85, lines: ['    write(order, input.orderId, row => {'] },
    {
      id: 'not-found',
      path: README_FILE,
      from: 86,
      lines: ["      if (!row) return CommandNotFound({ detail: 'Order not found' });"],
    },
    {
      id: 'conflict',
      path: README_FILE,
      from: 87,
      lines: [
        "      if (row.status !== 'placed') return CommandConflict({ detail: `Order is already ${row.status}` });",
      ],
    },
    {
      id: 'event',
      path: README_FILE,
      from: 88,
      lines: ['      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing'],
    },
    { id: 'close', path: README_FILE, from: 89, lines: ['    }),'] },
    { id: 'end', path: README_FILE, from: 90, lines: [');'] },
  ],
} as const satisfies Excerpt;

/** Where the refund workflow starts, retries and waits, then the webhook that sends its signal. */
export const REFUND_WORKFLOW = {
  parts: [
    {
      id: 'start',
      path: REFUND_WORKFLOW_FILE,
      from: 124,
      lines: [
        '        startOn: {',
        '          entity: refund,',
        '          event: refundsJournal.events.RefundApproved,',
        '          id: e => refundRunId(e.entityId),',
        '          input: e => ({ refundId: e.entityId }),',
        '        },',
      ],
    },
    {
      id: 'key',
      path: REFUND_WORKFLOW_FILE,
      from: 175,
      lines: [
        '              // The same on every try of this step: Stripe answers a repeat with the first refund',
        '              idempotencyKey: key,',
        '              amount: fromMinorColumn(amountMinor, currency),',
      ],
    },
    {
      id: 'wait',
      path: REFUND_WORKFLOW_FILE,
      from: 201,
      lines: [
        "      .waitFor('settled', {",
        "        signal: 'stripe.refund.settled',",
        '        schema: settledSchema,',
        "        timeout: '3d',",
      ],
    },
    {
      id: 'timeout',
      path: REFUND_WORKFLOW_FILE,
      from: 205,
      lines: ['        // No signal in 3 days: `record` asks Stripe', "        onTimeout: 'continue',"],
    },
    {
      id: 'signal',
      path: 'apps/kapodopera/backend/src/features/_shared/payments/services.ts',
      from: 121,
      lines: ["    { signal: input => runCommand(refundWorkflow.signal('stripe.refund.settled'), input) },"],
    },
  ],
} as const satisfies Excerpt;

export const SERVE_APP = {
  parts: [
    {
      id: 'serve',
      path: APP_FILE,
      from: 44,
      lines: [
        '    tanstackStart({',
        '      needs: { rpc: gateway.provides.rpc, auth: authn.provides.auth, scheduler },',
        '      session: ({ auth }, request) => auth.principal(request.headers),',
        '      rpc: ({ rpc }, request) => rpc.client(request.headers),',
      ],
    },
  ],
} as const satisfies Excerpt;

export const EXPLAIN_COMMAND = {
  parts: [
    {
      id: 'explain',
      path: QUICKSTART_FILE,
      from: 133,
      lines: ["dot explain --app src/app.ts --json | jq -c '.data.plugins[], .data.dependencies[]'"],
    },
  ],
} as const satisfies Excerpt;

export const START_IN_TEST = {
  parts: [
    {
      id: 'start',
      path: 'demos/faultline/backend/src/delivery.test.ts',
      from: 25,
      lines: ['  started = orThrow(await app.start());'],
    },
  ],
} as const satisfies Excerpt;

/** Every excerpt on the page, for the test that opens the files. */
export const ALL_EXCERPTS = [
  DEFINE_APP,
  WIRE_MISTAKE,
  WIRE_FIX,
  FEATURE_NEEDS,
  FEATURE_USECASE,
  PAY_ORDER,
  REFUND_WORKFLOW,
  SERVE_APP,
  EXPLAIN_COMMAND,
  START_IN_TEST,
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
    kicker: 'the app is a chain',
    title: 'The app is the chain. Nothing is auto-loaded.',
    excerpts: [DEFINE_APP],
  },
  {
    id: 'wire',
    number: 'F2',
    verb: 'Wire',
    kicker: 'the compiler checks the order',
    title: 'Swap two lines. The compiler refuses.',
    sheet: 'A-101',
    excerpts: [WIRE_MISTAKE, WIRE_FIX],
  },
  {
    id: 'feature',
    number: 'F3',
    verb: 'Feature',
    kicker: 'model · usecases · infra · entrypoints',
    title: 'A feature names what it needs. Usecases get only what they pick.',
    excerpts: [FEATURE_NEEDS, FEATURE_USECASE],
  },
  {
    id: 'remember',
    number: 'F4',
    verb: 'Remember',
    kicker: '@arki/journal · its own chapter',
    title: 'One transaction. Domain history and workflow history in one log.',
    sheet: 'J-001',
    excerpts: [PAY_ORDER, REFUND_WORKFLOW],
  },
  {
    id: 'serve',
    number: 'F5',
    verb: 'Serve',
    kicker: 'TanStack Start',
    title: 'TanStack Start is the front door. Every route gets typed services.',
    excerpts: [SERVE_APP],
  },
  {
    id: 'inspect',
    number: 'F6',
    verb: 'Inspect',
    kicker: 'and test',
    title: 'Read the graph before boot. Boot the same graph in a test.',
    excerpts: [EXPLAIN_COMMAND, START_IN_TEST],
  },
] as const satisfies readonly BuildStep[];

export const BUILD_STEPS: readonly BuildStep[] = STEP_LIST;

export const [DEFINE_STEP, WIRE_STEP, FEATURE_STEP, REMEMBER_STEP, SERVE_STEP, INSPECT_STEP] = STEP_LIST;

/** The four rooms of a feature, as the design draws them. */
export const FEATURE_ROOMS = [
  { name: 'model', text: 'tables, schemas, ids' },
  { name: 'usecases', text: 'the rules' },
  { name: 'infra', text: 'store, limiter, turnstile' },
  { name: 'entrypoints', text: 'rpc contract' },
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
