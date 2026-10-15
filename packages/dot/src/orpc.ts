/**
 * `@arki/dot/orpc` — oRPC for `defineFeature` features, contract first
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, Part B).
 *
 *   // app: core/orpc.ts
 *   export const bind = needsMiddleware<RequestContext>();
 *
 *   // features/digest/feature.ts
 *   export const core = defineFeature('digest').needs({ plans }).infra(store).usecases(createUsecases);
 *   export const os = implement(digestContract).$context<RequestContext>().use(bind(core));
 *   export const digest = core.entrypoints(rpc(digestContract, procedures(os)));
 *
 *   // features/digest/entrypoints/procedures.ts — `import type` only, so no runtime back-import
 *   import type { os } from '../feature';
 *   export const procedures = (o: typeof os) => ({ preview: o.preview.handler(({ context }) => context.usecases.preview()) });
 *
 * Two pieces:
 *
 * - `needsMiddleware<Ctx>()` makes the app's `bind`. `bind(core)` puts the
 *   feature's needs, private infra and usecases on the handler context, by
 *   alias, read from the request's services bag. The request context keeps
 *   request data only (`session`, `headers`, `services`); the feature's
 *   dependencies are declared once, in its chain, where `dot explain` sees them.
 * - `rpc(contract, router)` is the entrypoint descriptor. It accepts a
 *   router only if it implements the contract — a bare `os` router, a missing
 *   procedure or the wrong contract do not compile.
 *
 * `@orpc/server` is an optional peer. Import this module only in an app that
 * serves oRPC; the rest of Dot never loads it.
 */
import type { ContractRouter, IntersectPick, Meta, Router } from '@orpc/server';
import { os } from '@orpc/server';

import type { RpcEntrypoint } from './define-feature.js';
import type { HandleEntries, ServicesBag } from './feature.js';
import type { CtxOf, NeedsShape } from './plugin-contract.js';
import { resolveNeeds } from './feature.js';

/** The least a request context carries for `bind`: the services bag the gateway built for this request. */
export type RequestContextShape = { readonly services: ServicesBag };

/** What `bind(core)` adds to a handler's context: every handle of the core, resolved, under its alias. */
export type BoundContext<H extends NeedsShape> = CtxOf<HandleEntries<H>>;

/** Aliases that would land on top of a request-context key (the app's own extra keys included). */
type Shadowed<Ctx, H> = keyof H & keyof Ctx;

type ShadowGuard<Ctx, H> = [Shadowed<Ctx, H>] extends [never]
  ? unknown
  : { readonly 'DOT: a feature alias shadows a request-context key': Shadowed<Ctx, H> };

/**
 * Make the app's `bind` for its request context type, once:
 * `export const bind = needsMiddleware<RequestContext>()`.
 *
 * `bind(core)` is an oRPC middleware. It resolves `core.handles` from
 * `context.services` (missing key → `FEATURE_E005`, naming the alias) and
 * adds them to the context. Driven services such as `db` are not handles, so
 * they never reach a handler unless the feature itself needs them — the
 * feature's store does, the procedure does not.
 *
 * An alias equal to a request-context key is a compile error at `bind(core)`;
 * `session`, `headers`, `services` and `usecases` are already refused by
 * `defineFeature` (and at runtime there, for callers that skip the types).
 */
export function needsMiddleware<Ctx extends RequestContextShape>() {
  const base = os.$context<Ctx>();
  return <H extends NeedsShape>(core: { readonly handles: H } & ShadowGuard<Ctx, H>) =>
    base.middleware(({ context, next }) =>
      next({
        // Erasure seam: oRPC asks that new context keys agree with the current
        // ones (`IntersectPick`). No alias is a request key — the guard above
        // proves it — but TypeScript cannot see that through a generic `H`.
        context: resolveNeeds(context.services, core.handles) as BoundContext<H> & IntersectPick<Ctx, BoundContext<H>>,
      }),
    );
}

/**
 * The feature's oRPC entrypoint: its contract and the router that implements
 * it. `Router<C, never>` is oRPC's own "implements" check — same procedures,
 * same schemas — and `never` as the initial context accepts whatever context
 * the app's implementer settled on. `DefinedFeature.contract` / `.router` are
 * read from this descriptor, so `routerFor(appContract, features)` finds the
 * feature by its contract.
 */
export function rpc<C extends ContractRouter<Meta>, R extends Router<C, never>>(
  contract: C,
  router: R,
): RpcEntrypoint<C, R> {
  // The router is static: it is the same object before boot and after, so `resolve` just hands it back.
  return { kind: 'rpc', key: 'rpc', actions: [], contract, router, resolve: () => router };
}
