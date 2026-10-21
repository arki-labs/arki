/** How a piece of a code line is drawn: keywords in the accent colour, functions bold, comments muted. */
export type CodeKind = 'plain' | 'keyword' | 'fn' | 'comment';

type CodeToken = readonly [kind: CodeKind, text: string];

type Floor = {
  /** The floor's name in the elevation drawing (first word only is drawn). */
  name: string;
  title: string;
  text: string;
  /** Where the code lines come from: the package's README quick start. */
  readme: string;
  /** Lines copied exactly from that README; the e2e test checks each one against the file. */
  code: readonly (readonly CodeToken[])[];
  /** Package short names on this floor. */
  packages: readonly string[];
};

/** The six floors of the construction sequence, foundation first. Every floor depends only on the floors below it. */
export const FLOORS = [
  {
    name: 'Foundation',
    title: 'Validate input. Return failures as values.',
    text: 'No app around it yet. Schemas, typed failures, logging, dates, strings, a clock you pass in, math and async helpers. Import one and stop there.',
    readme: 'packages/schema/README.md',
    code: [
      [
        ['keyword', 'const'],
        ['plain', ' age = '],
        ['fn', 'parse'],
        ['plain', '(z.'],
        ['fn', 'string'],
        ['plain', '().'],
        ['fn', 'transform'],
        ['plain', "(Number), '42');"],
      ],
      [
        ['keyword', 'if'],
        ['plain', ' ('],
        ['fn', 'isFailure'],
        ['plain', '(age)) '],
        ['keyword', 'throw new'],
        ['plain', ' '],
        ['fn', 'Error'],
        ['plain', '(age.message);'],
      ],
    ],
    packages: ['schema', 'failure', 'contracts', 'log', 'ts', 'date', 'string', 'clock', 'math', 'async'],
  },
  {
    name: 'DOT Kernel',
    title: 'Compose packages into an app.',
    text: 'A Dot app is a chain of plugins. A plugin names what it needs and what it provides. Typed command-line programs, environment variables and resilience primitives share this floor.',
    readme: 'packages/dot/README.md',
    code: [
      [
        ['keyword', 'const'],
        ['plain', ' app = '],
        ['keyword', 'await'],
        ['plain', ' '],
        ['fn', 'defineApp'],
        ['plain', "('acme')"],
      ],
      [
        ['plain', '  .'],
        ['fn', 'use'],
        ['plain', '(dbPlugin) '],
        ['comment', '// providers before consumers — enforced at compile time'],
      ],
      [
        ['plain', '  .'],
        ['fn', 'use'],
        ['plain', '(billingPlugin)'],
      ],
    ],
    packages: ['cli', 'dot', 'env', 'resilience'],
  },
  {
    name: 'Infrastructure',
    title: 'Connect Postgres, queues, mail and sign-in.',
    text: 'Adapters for what an app talks to: Drizzle repositories, key-value stores, typed HTTP, journals, live queries, locks, mail, sign-in, schedules, background jobs and test tooling.',
    readme: 'packages/db/README.md',
    code: [
      [
        ['keyword', 'const'],
        ['plain', ' { db, close } = '],
        ['fn', 'orThrow'],
        ['plain', '('],
        ['keyword', 'await'],
        ['plain', ' '],
        ['fn', 'initDbRuntimeLocal'],
        ['plain', "({ dataDir: 'memory://' }, { relations: {} }));"],
      ],
    ],
    packages: ['db', 'kv', 'http', 'journal', 'live', 'lock', 'mail', 'auth', 'schedule', 'queue', 'testing'],
  },
  {
    name: 'Frontend',
    title: 'Put a React interface on it.',
    text: 'Theme, icons, hooks, shared design systems and a component library. Each component imports from its own subpath.',
    readme: 'packages/ui/README.md',
    code: [
      [
        ['keyword', 'import'],
        ['plain', ' { Button } '],
        ['keyword', 'from'],
        ['plain', " '@arki/ui/button';"],
      ],
      [
        ['keyword', 'import'],
        ['plain', ' { Card, CardContent, CardHeader, CardTitle } '],
        ['keyword', 'from'],
        ['plain', " '@arki/ui/card';"],
      ],
    ],
    packages: ['theme', 'icons', 'react-hooks', 'design-systems', 'ui'],
  },
  {
    name: 'Specialized',
    title: 'Handle money, payments and expressions.',
    text: 'Exact money, benchmarks you can publish, payments, a safe expression language and a bounded computer algebra package on top of it.',
    readme: 'packages/money/README.md',
    code: [
      [
        ['fn', 'money'],
        ['plain', "(100, 'EUR')."],
        ['fn', 'allocate'],
        ['plain', '([1, 1, 1]); '],
        ['comment', '// [33.34, 33.33, 33.33] — adds back to 100.00'],
      ],
    ],
    packages: ['money', 'bench', 'payments', 'expr', 'cas'],
  },
  {
    name: 'AI',
    title: 'Add local-first AI last.',
    text: 'Embeddings, model calls and chat UI. Nothing leaves your machine until you call a model.',
    readme: 'packages/ai/README.md',
    code: [
      [
        ['plain', 'console.'],
        ['fn', 'log'],
        ['plain', '('],
        ['fn', 'resolveEmbeddingSelection'],
        ['plain', "({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' }));"],
      ],
    ],
    packages: ['embeddings', 'ai', 'chat-ui'],
  },
] as const satisfies readonly Floor[];
