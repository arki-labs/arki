/**
 * `@orpc/server` adapter: what an oRPC client sees when a command fails, and who runs it.
 *
 * - `toORPCError(error)` maps one error, or one returned failure.
 * - `commandErrors()` is the middleware that maps whatever a procedure throws, and a failure it returns.
 * - `actorRun(select)` is the middleware that puts `context.run`, bound to the request's
 *   actor, on a procedure's context.
 *
 * - `idempotent(options)` is the middleware that reads the `Idempotency-Key` header and hands the
 *   key to `actorRun`, so each command the procedure runs is a receipt under that key.
 *
 * `@orpc/server` is an optional peer. Import this module only in an app that
 * serves oRPC. May import `errors` only; this is the one file that may import
 * `@orpc/server`.
 */
import type { IntersectPick } from '@orpc/server';
import { ORPCError, os } from '@orpc/server';

import { TransactionDefect } from '@arki/db/errors';
import { isFailure } from '@arki/failure';

import type { RunOptions } from './api.js';
import { isJournalError } from './errors.js';

/**
 * Another request changed the same entity first, or the client's `expectedVersion`
 * is behind. Nothing was written. Repeating the same request as it stands fails
 * again when a version was given, so the client reloads first. The journal's own
 * message names the entity kind and id; the client does not get those.
 */
const CONFLICT_MESSAGE = 'This was changed by another request. Reload the current state and try again.';

/**
 * - A failure (`@arki/failure`), such as `CommandNotFound`, becomes the `ORPCError` with its code,
 *   status, message and data: what `orThrowRpc` from `@arki/failure/orpc` throws for a failure the
 *   contract does not list. A contract that lists it with `errorMap` gets it typed instead.
 * - A `JournalError` with code `CONFLICT` becomes an `ORPCError('CONFLICT')`, a 409 the client can retry.
 *   So does the `TransactionDefect` that `journal.run` returns for it: the same lost race, after the rollback.
 * - Anything else is returned unchanged: the app decides what it means.
 *
 * The original error is NOT attached as `cause`. The journal's message names the entity kind and
 * id, and a host may log or serialize a cause. A host that wants the original logs it itself,
 * in a middleware placed inside this one.
 */
export function toORPCError(error: unknown): unknown {
  // Checked before any failure: a command run returns a CONFLICT its writes threw as `TransactionDefect`.
  if (isJournalError(error, 'CONFLICT') || (TransactionDefect.is(error) && isJournalError(error.cause, 'CONFLICT'))) {
    return new ORPCError('CONFLICT', { message: CONFLICT_MESSAGE });
  }
  if (isFailure(error)) {
    return new ORPCError(error.code, { status: error.status, message: error.message, data: error.data });
  }
  return error;
}

/**
 * The middleware form of `toORPCError`. Add it once to the app's procedure
 * builders, and no procedure needs a try/catch around a command. A procedure
 * that returns a failure, such as `context.run(...)`'s, answers with it as an
 * error too, never as a success. Only a procedure without an output schema can
 * do that: one with a schema fails output validation first. Such a procedure,
 * and every contract-first one, hands the result to `orThrowRpc(result, errors)`
 * from `@arki/failure/orpc` instead, so the client gets the failure typed.
 *
 * Order: put it INSIDE the app's own error middleware, so after it in the
 * chain: `os.use(appErrors).use(commandErrors())`. A rejected rule is then
 * already an `ORPCError` when the app's middleware sees it, and passes. Placed
 * before it, the app's middleware sees a plain error first and answers 500.
 */
export function commandErrors() {
  return os.middleware(async ({ next }) => {
    const answered = async () => {
      try {
        return await next();
      } catch (error) {
        throw toORPCError(error);
      }
    };
    const result = await answered();
    // `<unknown>`: oRPC types the output as `any` here.
    if (isFailure<unknown>(result.output)) throw toORPCError(result.output);
    return result;
  });
}

/**
 * The journal's door, as `actorRun` reads it off the context: `bind(source, meta)` returns a
 * runner whose writes carry `meta`. Written structurally so any journal fits, whatever its
 * meta schema, transaction and database types.
 */
type Door = { bind(source: never, meta: never, opts?: RunOptions): unknown };

type DoorSource<J extends Door> = Parameters<J['bind']>[0];
type DoorMeta<J extends Door> = Parameters<J['bind']>[1];
type DoorRunner<J extends Door> = ReturnType<J['bind']>;

/** What `actorRun` adds: `run`, the journal's runner for this request's actor. */
export type RunContext<TContext extends { readonly journal: Door }> = { readonly run: DoorRunner<TContext['journal']> };

/** What `actorRun` needs on the context besides what `select` reads: the database the journal opens transactions on. */
export type ActorRunContext<TContext extends { readonly journal: Door }> = TContext & {
  readonly db: DoorSource<TContext['journal']>;
  /** Set by `idempotent()`, placed before `actorRun`. When present, the bound runner runs each command under it. */
  readonly idempotencyKey?: string | undefined;
};

/**
 * Middleware that adds `context.run`: the journal's command runner, bound to the database
 * and to the meta (`{ actorId }`, …) that `select` reads from the request.
 *
 * ```ts
 * // app: core/orpc.ts — the app decides who the actor is; the journal assumes no session shape.
 * export const asActor = actorRun((context: { session: Session | null; journal: AppJournal }) => {
 *   if (!context.session) throw new ORPCError('UNAUTHORIZED');
 *   return { actorId: context.session.user.id };
 * });
 *
 * // a procedure, after the feature's `bind(core)` put `journal` and `db` on the context
 * os.pay.use(asActor).handler(({ context, input }) => context.run(payOrder, input));
 * ```
 *
 * The procedure must already have `journal` and `db` on its context — usually because the
 * feature `needs` them, which also puts the feature → journal → db edges in `dot explain`.
 * A procedure without them, or with a `db` the journal cannot write through, does not compile.
 * Binding the actor is not authorization: the command still checks what the actor may do.
 */
export function actorRun<TContext extends { readonly journal: Door }>(
  select: (context: TContext) => DoorMeta<TContext['journal']>,
) {
  return os.$context<ActorRunContext<TContext>>().middleware(({ context, next }) => {
    // Erasure seam: `bind`'s parameter types are read from the journal type with `Parameters`,
    // which TypeScript cannot relate back to the method while `TContext` is generic.
    const door = context.journal as {
      bind(
        source: DoorSource<TContext['journal']>,
        meta: DoorMeta<TContext['journal']>,
        opts?: RunOptions,
      ): DoorRunner<TContext['journal']>;
    };
    const key = context.idempotencyKey;
    const run = door.bind(
      context.db,
      select(context),
      key === undefined ? undefined : { idempotencyKey: key, keyPerCommand: true },
    );
    // Erasure seam: oRPC asks that a new context key agree with the current context
    // (`IntersectPick`); `run` is new, but TypeScript cannot see that through a generic `TContext`.
    return next({
      context: { run } as RunContext<TContext> & IntersectPick<ActorRunContext<TContext>, RunContext<TContext>>,
    });
  });
}

export type IdempotentOptions<TContext> = {
  /**
   * Who is asking: the signed-in actor or tenant. The key becomes `${scope.length}:${scope}:${header value}`, so two
   * callers never share a key. Return `undefined` for an anonymous request: it runs with no key.
   */
  readonly scope: (context: TContext) => string | undefined;
  /** The request header that carries the key. Default `Idempotency-Key`. */
  readonly header?: string;
  /** Refuse (`BAD_REQUEST`) a request that has no key. Default false: no header, no idempotency. */
  readonly required?: boolean;
};

const MAX_KEY_LENGTH = 200;

/**
 * Middleware that reads the idempotency header from `context.headers` and puts the scoped key on
 * the context as `idempotencyKey`. Place it BEFORE `actorRun`: `actorRun` then binds the runner so
 * that each command a procedure runs is a receipt under `${key}:${commandName}`. A repeat of the
 * request replays every command's stored result instead of writing again. A command's input must
 * match the first run, or the repeat is `CONFLICT`.
 *
 * ```ts
 * os.use(idempotent({ scope: ctx => ctx.session?.user.id })).use(asActor)
 * ```
 *
 * This is the oRPC form. A plain HTTP route uses `idempotent` from `@arki/http/idempotency`,
 * which caches the whole response. A procedure can use both: the HTTP cache answers a repeat
 * without running anything, and the receipts still protect a repeat that reached the handler.
 * `context.headers` is a fetch `Headers`, as the oRPC fetch adapter provides it.
 */
export function idempotent<TContext extends { readonly headers: Headers }>(options: IdempotentOptions<TContext>) {
  const header = options.header ?? 'Idempotency-Key';
  type Added = { readonly idempotencyKey: string | undefined };
  // Erasure seam, as in `actorRun`: oRPC asks that a new context key agree with the current context
  // (`IntersectPick`), and TypeScript cannot see that through a generic `TContext`.
  const added = (idempotencyKey?: string) => ({ idempotencyKey }) as Added & IntersectPick<TContext, Added>;
  return os.$context<TContext>().middleware(({ context, next }) => {
    const supplied = context.headers.get(header)?.trim();
    if (supplied === undefined || supplied === '') {
      if (options.required === true)
        throw new ORPCError('BAD_REQUEST', { message: `${header} is required for this operation` });
      return next({ context: added() });
    }
    if (supplied.length > MAX_KEY_LENGTH)
      throw new ORPCError('BAD_REQUEST', { message: `${header} must be at most ${MAX_KEY_LENGTH} characters` });
    const scope = options.scope(context);
    // The scope's length goes first: the client picks the key, colons included, so `a` + `b:c` and
    // `a:b` + `c` must not meet in one key.
    return next({ context: added(scope === undefined ? undefined : `${scope.length}:${scope}:${supplied}`) });
  });
}
