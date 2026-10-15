/** feature.ts: the whole chain, the one map of the feature. Usecase and procedure files take `Deps` / `os` as types only. */
import { implement } from '@orpc/server';

import type { DepsOf } from '../../../../feature.js';
import type { RequestContext } from '../orpc.js';
import { defineFeature } from '../../../../feature.js';
import { rpc } from '../../../../orpc.js';
import { billing } from '../infra.js';
import { bind } from '../orpc.js';
import { digestContract } from './contract.js';
import { previewProcedure } from './procedures/preview.js';
import { store } from './store.js';
import { preview } from './usecases/preview.js';

const base = defineFeature('digest').needs({ plans: billing.provides.entitlements }).infra(store);

/** What a usecase may ask for: the needs by alias and the infra services by key. */
export type Deps = DepsOf<typeof base>;

export const core = base.usecases({ preview });

export const os = implement(digestContract).$context<RequestContext>().use(bind(core));

export const digest = core.entrypoints(rpc(digestContract, os, { preview: previewProcedure }));
