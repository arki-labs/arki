import type { CoolifyClient } from './client';
import type { CoolifySignal } from './signals';
import type { CoolifyHint } from './webhook';
import { ADMIN_ERROR_CODES, AdminError } from '../../errors';
import { applicationSignal, deploymentSignal, serverSignal } from './signals';

/**
 * Turn a hint into signals by asking the Coolify API. The webhook's own content is never
 * copied into a signal. A resource the API does not know, or one that looks fine, gives `[]`.
 * Other failures (token rejected, timeout, schema drift) are thrown so the caller can retry.
 */
export async function confirmHint(
  client: Pick<CoolifyClient, 'getDeployment' | 'getApplication' | 'getServer'>,
  hint: CoolifyHint,
): Promise<CoolifySignal[]> {
  try {
    switch (hint.kind) {
      case 'deployment': {
        return [deploymentSignal(await client.getDeployment(hint.resourceUuid), hint.receivedAt)];
      }
      case 'application': {
        return orNone(applicationSignal(await client.getApplication(hint.resourceUuid), hint.receivedAt));
      }
      case 'server': {
        return orNone(serverSignal(await client.getServer(hint.resourceUuid), hint.receivedAt));
      }
      case 'unknown': {
        return [];
      }
    }
  } catch (error) {
    if (error instanceof AdminError && error.code === ADMIN_ERROR_CODES.unknownCapability) return [];
    throw error;
  }
}

const orNone = (s: CoolifySignal | null): CoolifySignal[] => (s === null ? [] : [s]);
