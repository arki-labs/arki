import type {
  Meta,
  MiddlewareOptions,
  MiddlewareOutputFn,
  MiddlewareResult,
  ORPCErrorConstructorMap,
} from '@orpc/server';

import type { SnapshotRunner } from '../runner.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { liveMetaSchema } from '../schema.js';

/** What `liveRead()` adds to the handler's context: the readers bound to this call's snapshot. */
export type LiveReadContext<Readers> = { readonly liveRead: Readers };

/**
 * oRPC middleware that runs the rest of the chain inside one snapshot. Generic
 * in the procedure's output and meta, so one `liveRead(...)` fits any
 * procedure; it reads only `context`, `path`, `procedure` and `next`, so any
 * error map is accepted.
 */
export type LiveReadMiddleware<Context extends object, Readers> = <Output, TMeta extends Meta>(
  options: Pick<
    MiddlewareOptions<Context, Output, ORPCErrorConstructorMap<Record<never, never>>, TMeta>,
    'context' | 'path' | 'procedure' | 'next'
  >,
  input: unknown,
  output: MiddlewareOutputFn<Output>,
) => Promise<MiddlewareResult<LiveReadContext<Readers>, Output>>;

/** Procedures whose contract meta was checked once. */
const declared = new WeakSet<object>();

function requireLiveMeta(procedure: object, meta: Meta, path: readonly string[]): void {
  if (declared.has(procedure)) return;
  const parsed = liveMetaSchema.safeParse(meta);
  if (!parsed.success || parsed.data.live === undefined) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `liveRead() on ${path.join('.') || 'a procedure'} without live meta`,
      'Declare the tables the procedure reads in its contract: oc.meta(live({ reads: [...] })).',
    );
  }
  declared.add(procedure);
}

/**
 * Runs `next()` inside one snapshot and adds `context.liveRead`: every read
 * through those readers sees the same Postgres snapshot. Throws E001 when the
 * procedure's contract has no live meta.
 *
 *   p.list.use(liveRead((ctx: Deps) => snapshot(ctx.db, tx => ctx.repos.withTx(tx))))
 */
export function liveRead<Context extends object, Readers>(
  select: (context: Context) => SnapshotRunner<Readers>,
): LiveReadMiddleware<Context, Readers> {
  return async ({ context, path, procedure, next }) => {
    requireLiveMeta(procedure, procedure['~orpc'].meta, path);
    return select(context)(async readers => next({ context: { liveRead: readers } }));
  };
}
