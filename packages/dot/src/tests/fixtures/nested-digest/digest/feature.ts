/** Parent: `digest`. Owns the store (repos), nests `compile` and `deliver`, re-exports the compiler. Entrypoints open transactions. */
import { implement } from '@orpc/server';

import type { DepsOf } from '../../../../feature.js';
import type { RequestContext } from '../../rpc-app/orpc.js';
import { defineFeature, entrypointOnly } from '../../../../feature.js';
import { rpc } from '../../../../orpc.js';
import { bind } from '../../rpc-app/orpc.js';
import { database, projectionsUnit } from '../db.js';
import { digestProcedures } from './entrypoints/procedures.js';
import { digestRpcContract } from './entrypoints/rpc.js';
import { compile } from './features/compile/feature.js';
import { deliver } from './features/deliver/feature.js';
import { store } from './infra/store.js';
import { run } from './usecases/run.js';

/** A stand-in for `journalProjections(...)` in `.infra`: the real adapter finds it by `kind` among the node's units. */
export const digestProjections = projectionsUnit('digest-stats');

// `db` is entrypoint-only: procedures open transactions with it; usecases never see it.
const digestDeps = defineFeature('digest')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store, digestProjections)
  .features(compile, deliver);
export type DigestDeps = DepsOf<typeof digestDeps>;

// `compiler` hands the child's service up as is (an object, so it is not wrapped): `provides` sees only the usecases.
export const digestLogic = digestDeps.usecases({
  run,
  compiler: ({ compiler }: Pick<DigestDeps, 'compiler'>) => compiler,
});
export const rpcImplementer = implement(digestRpcContract).$context<RequestContext>().use(bind(digestLogic));

/** A stand-in for `schedules(digestLogic, [...])`: the parent declares only its own schedules. */
const digestSchedules = { kind: 'schedules', key: 'schedules', actions: [], resolve: () => ['send-digest'] } as const;

export const digest = digestLogic
  // `digests` is public (bare key). `compile` is the child's service, re-exported under the parent's name.
  .provides({ digests: ({ usecases }) => ({ run: usecases.run, compile: usecases.compiler.compile }) })
  .entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures), digestSchedules);
