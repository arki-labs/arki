/** Child: `digest.deliver`. Needs the parent's `repos` and its sibling's `compiler`; `db` only for its entrypoints; owns `mailer`. */
import { implement } from '@orpc/server';

import type { DepsOf } from '../../../../../../feature.js';
import type { RequestContext } from '../../../../rpc-app/orpc.js';
import { defineFeature, entrypointOnly } from '../../../../../../feature.js';
import { rpc } from '../../../../../../orpc.js';
import { bind } from '../../../../rpc-app/orpc.js';
import { database } from '../../../db.js';
import { store } from '../../infra/store.js';
import { compile } from '../compile/feature.js';
import { deliverProcedures } from './entrypoints/procedures.js';
import { deliverRpcContract } from './entrypoints/rpc.js';
import { mailer } from './infra/mailer.js';
import { sendFresh } from './usecases/send-fresh.js';
import { send } from './usecases/send.js';

const deliverDeps = defineFeature('digest.deliver')
  .needs({ db: entrypointOnly(database.provides.db), repos: store.provides.repos, compiler: compile.provides.compiler })
  .infra(mailer);
export type DeliverDeps = DepsOf<typeof deliverDeps>;

export const deliverLogic = deliverDeps.usecases({ send, sendFresh });
export const rpcImplementer = implement(deliverRpcContract).$context<RequestContext>().use(bind(deliverLogic));

export const deliver = deliverLogic
  .provides({ delivery: ({ usecases }) => ({ send: usecases.send }) })
  .entrypoints(rpc(deliverRpcContract, rpcImplementer, deliverProcedures));
