/** The app's `core/orpc.ts`: the request context, the app's `implement`, and one per-procedure guard. */
import { ORPCError, os } from '@orpc/server';

import type { ServicesBag } from '../../../feature.js';
import { rpcFor } from '../../../orpc.js';

export type RequestContext = {
  readonly session: { readonly user: { readonly id: string } } | null;
  readonly headers: Headers;
  readonly services: ServicesBag;
};

export const { bind, implement } = rpcFor<RequestContext>();

/** Applied after `bind`, per procedure: it narrows `session` and leaves the bound handles alone. */
export const authed = os.$context<RequestContext>().middleware(({ context, next }) => {
  if (!context.session) throw new ORPCError('UNAUTHORIZED');
  return next({ context: { session: context.session } });
});
