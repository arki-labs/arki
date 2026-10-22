/**
 * `with: [...]` on `defineCommand`: plain functions, typed at the command that lists them, with no
 * cast.
 *
 * Why these checks exist: a step's parameter is the only place its input is written, and its return
 * the only place its additions are written. `run` must see exactly what the steps added, in order;
 * a step that reads a key nobody has added yet (missing, or added by a later element) must not
 * compile. An around adds nothing, so the context after it equals the context before it. Listing
 * `with` must not break the inference of `input`, `args` and `ask` from the schema.
 */
import { expectTypeOf } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { NoServices, RunContext } from './command.js';
import { defineCommand } from './command.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type Db = { transaction<T>(work: () => Promise<T>): Promise<T> };
type Base = RunContext<undefined, NoServices>;

const SignInRequired = defineFailure('test.with.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.with.not_admin', { status: 403 });

declare const principal: Principal | null;
const authed = (ctx: { readonly mode: string }) =>
  principal === null ? SignInRequired() : { principal, via: ctx.mode };
const admin = (ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
const asOperator = (ctx: { readonly mode: string }) => ({
  principal: { user: { id: ctx.mode, email: 'op@arki.dev' } },
});
const traced = (ctx: { readonly mode: string }) => Promise.resolve({ traceId: ctx.mode });
declare const db: Db;
const withDb = () => ({ db });
const inTransaction = <T>(ctx: { readonly db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);
const timed = <T>(_ctx: { readonly mode: string }, next: () => Promise<T>) => next();

// A step adds the keys it returns; a later step reads what an earlier one added, in order.
defineCommand({
  describe: 'x',
  with: [authed, admin],
  run: ctx => {
    expectTypeOf(ctx).toEqualTypeOf<Base & { principal: Principal; via: string } & { isAdmin: true }>();
    return ctx.isAdmin;
  },
});

// An async step is awaited.
defineCommand({
  describe: 'x',
  with: [traced],
  run: ctx => {
    expectTypeOf(ctx.traceId).toEqualTypeOf<string>();
    return 0;
  },
});

// An around adds nothing: the context after it is the context before it. An inline around is written generic in `T`, like any around.
defineCommand({
  describe: 'x',
  with: [
    withDb,
    inTransaction,
    timed,
    async <T>(ctx: { readonly mode: string }, next: () => Promise<T>) => (ctx.mode === 'json' ? next() : next()),
  ],
  run: ctx => {
    expectTypeOf(ctx).toEqualTypeOf<Base & { db: Db }>();
    return 0;
  },
});

// `preview` gets the same context as `run`.
defineCommand({
  describe: 'x',
  with: [asOperator],
  preview: ctx => ctx.principal.user.id,
  run: ctx => ctx.principal.user.id,
});

// `input`, `args` and `ask` still infer from the schema with `with` present.
const withInput = defineCommand({
  describe: 'x',
  input: z.object({ size: z.number().default(1), label: z.string() }),
  args: ['label'],
  ask: { label: 'Label?' },
  with: [asOperator],
  run: ({ input, principal: operator }) => {
    expectTypeOf(input).toEqualTypeOf<{ size: number; label: string }>();
    return { size: input.size, operator: operator.user.id };
  },
});
expectTypeOf(withInput.args).toEqualTypeOf<readonly ('size' | 'label')[] | undefined>();
defineCommand({
  describe: 'x',
  input: z.object({ label: z.string() }),
  // @ts-expect-error — `nope` is not an input key
  args: ['nope'],
  with: [asOperator],
  run: () => 0,
});

// A command without `with` keeps the plain context.
defineCommand({
  describe: 'x',
  run: ctx => {
    expectTypeOf(ctx).toEqualTypeOf<Base>();
    return 0;
  },
});

// `admin` reads a principal nobody has added.
defineCommand({
  describe: 'x',
  // @ts-expect-error — the context has no `principal` yet
  with: [admin],
  run: () => 0,
});

// `admin` listed before the step that provides its input does not compile.
defineCommand({
  describe: 'x',
  // @ts-expect-error — `authed` comes after `admin`
  with: [admin, authed],
  run: () => 0,
});

// An around that reads a key the context lacks does not compile.
defineCommand({
  describe: 'x',
  // @ts-expect-error — no earlier element added `db`
  with: [inTransaction],
  run: () => 0,
});

// A step must add an object: a bare value has no key to land under.
defineCommand({
  describe: 'x',
  // @ts-expect-error — `string` is not an object
  with: [(ctx: { readonly mode: string }) => ctx.mode],
  run: () => 0,
});

// The step's keys are not on the context of a command that does not list it.
defineCommand({
  describe: 'x',
  // @ts-expect-error — `principal` is not on the base context
  run: ctx => ctx.principal,
});
