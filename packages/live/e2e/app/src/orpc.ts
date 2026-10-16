import type { ContractRouterClient } from '@orpc/contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';

import type { appContract } from './contract';

// The URL is read per call, in the browser: no loader prefetches, so oRPC is never called during SSR.
const rpcLink = new RPCLink({ url: () => new URL('/api/rpc', window.location.href) });
const rpcClient: ContractRouterClient<typeof appContract> = createORPCClient(rpcLink);

export const orpc = createTanstackQueryUtils(rpcClient);
