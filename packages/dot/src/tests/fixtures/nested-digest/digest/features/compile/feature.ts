/** Child: `digest.compile`. Needs the parent's private `repos`; `db` only for its entrypoints; owns `ranker`; nests `rank`. */
import { implement } from '@orpc/server';

import type { DepsOf } from '../../../../../../feature.js';
import type { RequestContext } from '../../../../rpc-app/orpc.js';
import { defineFeature, entrypointOnly } from '../../../../../../feature.js';
import { rpc } from '../../../../../../orpc.js';
import { bind } from '../../../../rpc-app/orpc.js';
import { database, projectionsUnit } from '../../../db.js';
import { store } from '../../infra/store.js';
import { compileProcedures } from './entrypoints/procedures.js';
import { compileRpcContract } from './entrypoints/rpc.js';
import { rank } from './features/rank/feature.js';
import { ranker } from './infra/ranker.js';
import { compileFor } from './usecases/compile-for.js';

/** A stand-in for `journalProjections(...)` in a CHILD's `.infra` — the one the real adapter used to count twice. */
export const compileProjections = projectionsUnit('compile-stats');

const compileDeps = defineFeature('digest.compile')
  .needs({ db: entrypointOnly(database.provides.db), repos: store.provides.repos })
  .infra(ranker, compileProjections)
  .features(rank);
export type CompileDeps = DepsOf<typeof compileDeps>;

export const compileLogic = compileDeps.usecases({ compileFor });
export const rpcImplementer = implement(compileRpcContract).$context<RequestContext>().use(bind(compileLogic));

/** A stand-in for `schedules(compileLogic, [...])`: the slice payload is the schedule names. */
const compileSchedules = {
  kind: 'schedules',
  key: 'schedules',
  actions: [],
  resolve: () => ['compile-digest'],
} as const;

export const compile = compileLogic
  .provides({ compiler: ({ usecases }) => ({ compile: usecases.compileFor }) })
  .entrypoints(rpc(compileRpcContract, rpcImplementer, compileProcedures), compileSchedules);
