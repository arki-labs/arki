/** The app's `core/orpc.ts`: the request context and the app's `bind`. */
import type { ServicesBag } from '@arki/dot/feature';
import { needsMiddleware } from '@arki/dot/orpc';

export type RequestContext = {
  readonly session: null;
  readonly headers: Headers;
  readonly services: ServicesBag;
};

export const bind = needsMiddleware<RequestContext>();
