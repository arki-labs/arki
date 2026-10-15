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
 *   Each procedure also becomes a manifest action, so `dot explain` lists
 *   the feature's procedures and the policy their contract meta declares.
 *
 * `@orpc/server` is an optional peer. Import this module only in an app that
 * serves oRPC; the rest of Dot never loads it.
 */
import type { ContractRouter, IntersectPick, Meta, Router } from '@orpc/server';
import { os, traverseContractProcedures } from '@orpc/server';

import type { RpcEntrypoint } from './define-feature.js';
import type { HandleEntries, ServicesBag } from './feature.js';
import type { JsonObject } from './manifest.js';
import type { ActionDeclaration, CtxOf, NeedsShape } from './plugin-contract.js';
import { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
import { resolveNeeds } from './feature.js';
import { toJsonObject } from './manifest.js';

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
 * feature by its contract. Its actions (one per procedure, `<feature>.<path>`)
 * are named when the feature compiles, through `actionsOf`.
 */
export function rpc<C extends ContractRouter<Meta>, R extends Router<C, never>>(
  contract: C,
  router: R,
): RpcEntrypoint<C, R> {
  // Read now, so a bad `meta` fails where the feature is declared, not at boot.
  const procedures = rpcProcedures(contract);
  return {
    kind: 'rpc',
    key: 'rpc',
    actions: [],
    actionsOf: feature => procedures.map(procedure => rpcAction(feature, procedure)),
    contract,
    router,
    // The router is static: it is the same object before boot and after, so `resolve` just hands it back.
    resolve: () => router,
  };
}

/** Identifies the layout of an rpc action's `meta`, for tools that read `dot explain --json`. */
export const RPC_ACTION_META_SCHEMA = '@arki/dot/rpc-action-meta@1';

type RpcProcedure = {
  readonly path: string;
  readonly method?: string;
  readonly route?: string;
  readonly summary?: string;
  readonly meta: JsonObject;
};

/** Every procedure of a contract with what `dot explain` shows: path, HTTP route, errors and declared meta. */
function rpcProcedures(contract: ContractRouter<Meta>): readonly RpcProcedure[] {
  const found: RpcProcedure[] = [];
  traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure, path }) => {
    const { route, meta, errorMap } = procedure['~orpc'];
    const name = path.join('.');
    const detail: JsonObject = { procedure: name };
    if (route.method !== undefined) detail['method'] = route.method;
    if (route.path !== undefined) detail['path'] = route.path;
    if (route.tags !== undefined && route.tags.length > 0) detail['tags'] = [...route.tags];
    if (route.deprecated === true) detail['deprecated'] = true;
    const errors = Object.keys(errorMap);
    if (errors.length > 0) detail['errors'] = errors;
    // Contract meta is where an app declares a procedure's policy (`oc.$meta<{ auth: 'admin' }>()`);
    // copying it here is what makes that policy visible without booting anything.
    if (Object.keys(meta).length > 0) detail['meta'] = jsonMeta(name, meta);
    found.push({
      path: name,
      ...(route.method === undefined ? {} : { method: route.method }),
      ...(route.path === undefined ? {} : { route: route.path }),
      ...(route.summary === undefined ? {} : { summary: route.summary }),
      meta: detail,
    });
  });
  return found;
}

function jsonMeta(procedure: string, meta: Meta): JsonObject {
  try {
    return toJsonObject(meta);
  } catch {
    throw new FeatureError({
      code: FEATURE_ERROR_CODES.rpcMetaNotJson,
      message: `[rpc] procedure "${procedure}" has contract meta that is not plain JSON, so dot explain cannot show it.`,
      remediation: 'Keep contract meta to strings, numbers, booleans, null, arrays and plain objects (no functions, dates or classes).',
    });
  }
}

/**
 * One manifest action per procedure. The id carries the feature
 * (`digest.preview`): ids are unique per binding across the app. The
 * address is the HTTP route when the contract declares one, else the path.
 */
function rpcAction(feature: string, procedure: RpcProcedure): ActionDeclaration {
  const route = procedure.route === undefined ? undefined : `${procedure.method ?? 'POST'} ${procedure.route}`;
  return {
    id: `${feature}.${procedure.path}`,
    binding: 'rpc',
    direction: 'in',
    address: route ?? procedure.path,
    ...(procedure.summary === undefined ? {} : { summary: procedure.summary }),
    metaSchema: RPC_ACTION_META_SCHEMA,
    meta: procedure.meta,
  };
}
