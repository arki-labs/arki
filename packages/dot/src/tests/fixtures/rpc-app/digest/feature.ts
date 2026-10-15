/** feature.ts: the whole chain. `core` and `os` stay here; entrypoint files take them as typed parameters. */
import { implement } from '@orpc/server';

import type { RequestContext } from '../orpc.js';
import { defineFeature } from '../../../../feature.js';
import { rpc } from '../../../../orpc.js';
import { billing } from '../infra.js';
import { bind } from '../orpc.js';
import { digestContract } from './contract.js';
import { procedures } from './procedures.js';
import { store } from './store.js';
import { createUsecases } from './usecases.js';

export const core = defineFeature('digest')
  .needs({ plans: billing.provides.entitlements })
  .infra(store)
  .usecases(createUsecases);

export const os = implement(digestContract).$context<RequestContext>().use(bind(core));

export const digest = core.entrypoints(rpc(digestContract, procedures(os)));
