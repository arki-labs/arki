/** The app's `core/orpc.ts`: the request context and the app's `implement`. */
import type { ServicesBag } from '@arki/dot/feature';
import { rpcFor } from '@arki/dot/orpc';

export type RequestContext = {
  readonly session: null;
  readonly headers: Headers;
  readonly services: ServicesBag;
};

export const { implement } = rpcFor<RequestContext>();
