import { isFailure } from '@arki/failure';

import type { CoolifyClient, CoolifyFailure } from './client';
import type { CoolifySignal } from './signals';
import type { CoolifyHint } from './webhook';
import { AdminUnknownCapability } from '../../failures';
import { applicationSignal, deploymentSignal, serverSignal } from './signals';

/**
 * Turn a hint into signals by asking the Coolify API. The webhook's own content is never
 * copied into a signal. A resource the API does not know, or one that looks fine, gives `[]`.
 * Other failures (token rejected, timeout, schema drift) are returned so the caller can retry.
 */
export async function confirmHint(
  client: Pick<CoolifyClient, 'getDeployment' | 'getApplication' | 'getServer'>,
  hint: CoolifyHint,
): Promise<CoolifySignal[] | CoolifyFailure> {
  switch (hint.kind) {
    case 'deployment': {
      const deployment = await client.getDeployment(hint.resourceUuid);
      return isGone(deployment) ? [] : isFailure(deployment) ? deployment : [deploymentSignal(deployment, hint.receivedAt)];
    }
    case 'application': {
      const application = await client.getApplication(hint.resourceUuid);
      return isGone(application) ? [] : isFailure(application) ? application : orNone(applicationSignal(application, hint.receivedAt));
    }
    case 'server': {
      const server = await client.getServer(hint.resourceUuid);
      return isGone(server) ? [] : isFailure(server) ? server : orNone(serverSignal(server, hint.receivedAt));
    }
    case 'unknown': {
      return [];
    }
  }
}

/** A resource the API does not know is not an error: there is nothing to signal. */
const isGone = (value: unknown): boolean => AdminUnknownCapability.is(value);

const orNone = (s: CoolifySignal | null): CoolifySignal[] => (s === null ? [] : [s]);
