/**
 * The mental model band on `/`: three ideas, each with the real code behind it. Kept apart from the build path's
 * excerpts because they come from three packages, not from the chain.
 */
import type { Excerpt } from './excerpt';

const FAILURE_README = 'packages/failure/README.md';
const DOT_README = 'packages/dot/README.md';
const ASYNC_README = 'packages/async/README.md';

/** The band's headline. */
export const MODEL_HEADLINE = 'Plain values, typed failures, declared wiring.';

/** A function returns its value or a failure; the compiler infers the union. */
export const RETURNS_VALUE_OR_FAILURE = {
  note: 'nobody wrote the return type',
  parts: [
    {
      id: 'imports',
      path: FAILURE_README,
      from: 26,
      imports: true,
      lines: ["import { defineFailure, isFailure } from '@arki/failure';"],
    },
    {
      id: 'define',
      path: FAILURE_README,
      from: 28,
      lines: [
        "const EmailTaken = defineFailure('user.email_taken', {",
        '  status: 409,',
        '  data: z.object({ email: z.string() }),',
        "  message: 'email {email} is taken (someone beat you to it)',",
        '});',
      ],
    },
    {
      id: 'return',
      path: FAILURE_README,
      from: 34,
      lines: [
        "const taken = new Set(['ada@example.com']);",
        'const signUp = (email: string) => (taken.has(email) ? EmailTaken({ email }) : { email });',
      ],
    },
    {
      id: 'check',
      path: FAILURE_README,
      from: 37,
      lines: [
        "const result = signUp('ada@example.com');",
        "if (!isFailure(result)) throw new Error('expected a failure');",
      ],
    },
  ],
} as const satisfies Excerpt;

/** A unit declares what it needs and what it provides; the chain checks the order. */
export const NEEDS_DECLARED_ON_UNIT = {
  note: 'the handle is typed',
  parts: [
    {
      id: 'imports',
      path: DOT_README,
      from: 33,
      imports: true,
      lines: ["import { defineApp, infra } from '@arki/dot';"],
    },
    {
      id: 'needs',
      path: DOT_README,
      from: 51,
      lines: [
        'const stripe = infra({',
        "  name: 'stripe',",
        '  needs: { db: database.provides.db }, // typed handle — destructure in hooks',
      ],
    },
    {
      id: 'provides',
      path: DOT_README,
      from: 58,
      lines: ['  provides: {', '    stripe: ({ db }) => makeStripeClient(db), // factories see the needs', '  },'],
    },
  ],
} as const satisfies Excerpt;

/** Work runs in a scope that owns it: every task joined, every cleanup run. */
export const RUNS_IN_OWNED_SCOPE = {
  note: 'cleanup runs newest first',
  parts: [
    {
      id: 'imports',
      path: ASYNC_README,
      from: 161,
      imports: true,
      lines: ["import { cleanup, resource, scoped } from '@arki/async';"],
    },
    {
      id: 'scope',
      path: ASYNC_README,
      from: 165,
      lines: [
        'const rows = await scoped({',
        '  db: resource(',
        "    () => ({ query: () => ['select 1'] }),",
        "    () => { events.push('db closed'); },",
        '  ),',
        "  metrics: cleanup(() => { events.push('metrics flushed'); }),",
        '}, ({ db }) => db.query());',
      ],
    },
  ],
} as const satisfies Excerpt;

type ModelPart = {
  /** The question the part answers, as a one-word label. */
  name: string;
  text: string;
  excerpt: Excerpt;
};

/** The three parts of the model, in reading order. */
export const MODEL_PARTS = [
  {
    name: 'Returns',
    text: 'The value itself, or a failure. Nobody writes the union; the compiler infers it, and the lint rule reports a call that throws a failure away. Bugs still throw.',
    excerpt: RETURNS_VALUE_OR_FAILURE,
  },
  {
    name: 'Needs',
    text: 'Declared on the unit, once. A unit names the handle it takes. If no unit before it provides that handle, the app will not compile, whether the provider comes later or not at all.',
    excerpt: NEEDS_DECLARED_ON_UNIT,
  },
  {
    name: 'Runs',
    text: 'Owned work on plain Promises and AbortSignal. A scope joins every task it started, then runs cleanup newest first. No fibers, no effect type.',
    excerpt: RUNS_IN_OWNED_SCOPE,
  },
] as const satisfies readonly ModelPart[];

export const MODEL_EXCERPTS = MODEL_PARTS.map(part => part.excerpt);
