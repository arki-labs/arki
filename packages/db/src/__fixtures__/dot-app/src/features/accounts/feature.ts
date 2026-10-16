/** The chain: the pool-bound repository source keeps its own name, `repositories`; `repos` is the bound set. */
import { implement } from '@orpc/server';

import type { DepsOf } from '@arki/dot/feature';
import { rename } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';

import type { TransactionScopeOf } from '../../../../../orpc.js';
import type { RequestContext } from '../../core/orpc.js';
import type { transact } from './entrypoints/transact.js';
import { transactionalProcedureConfig } from '../../../../../orpc.js';
import { database } from '../../core/database.js';
import { bind } from '../../core/orpc.js';
import { accountsProcedures } from './entrypoints/procedures.js';
import { accountsRpcContract } from './entrypoints/rpc.js';
import { repository } from './infra/repository.js';
import { balance } from './usecases/balance.js';
import { transfer } from './usecases/transfer.js';

const accountsDeps = defineFeature('accounts')
  .needs({ db: database.provides.db })
  .infra(rename(repository, { repos: 'repositories' }));

export type Deps = DepsOf<typeof accountsDeps>;
/** The scope a transaction-aware usecase takes: `{ tx, repos, '~arkiTransaction' }`, inferred from `transact`. */
export type AccountsTx = TransactionScopeOf<typeof transact>;

export const accountsLogic = accountsDeps.usecases({ transfer: () => transfer, balance });

export const rpcImplementer = implement(accountsRpcContract, transactionalProcedureConfig)
  .$context<RequestContext>()
  .use(bind(accountsLogic));

export const accounts = accountsLogic.entrypoints(rpc(accountsRpcContract, rpcImplementer, accountsProcedures));
