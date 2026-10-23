/** feature.ts: the whole chain, the one map of the feature. Usecase and procedure files take `Deps` / `rpcImplementer` as types only. */

import type { DepsOf } from '../../../../feature.js';
import { defineFeature, entrypointOnly } from '../../../../feature.js';
import { rpc } from '../../../../orpc.js';
import { billing, database } from '../infra.js';
import { implement } from '../orpc.js';
import { digestProcedures } from './procedures.js';
import { digestRpcContract } from './rpc.js';
import { store } from './store.js';
import { preview } from './usecases/preview.js';

const digestDeps = defineFeature('digest')
  .needs({ db: entrypointOnly(database.provides.db), plans: billing.provides.entitlements })
  .infra(store);

/** What a usecase may ask for: the needs by alias and the infra services by key. */
export type Deps = DepsOf<typeof digestDeps>;

export const digestLogic = digestDeps.usecases({ preview });

export const rpcImplementer = implement(digestRpcContract).with(digestLogic);

export const digest = digestLogic.entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures));
