/** Grandchild: `digest.compile.rank`. Needs the grandparent's `repos` and the parent's `ranker` — both by handle, both in scope. */
import type { DepsOf } from '../../../../../../../../feature.js';
import { defineFeature } from '../../../../../../../../feature.js';
import { store } from '../../../../infra/store.js';
import { ranker } from '../../infra/ranker.js';
import { top } from './usecases/top.js';

const rankDeps = defineFeature('digest.compile.rank').needs({ repos: store.provides.repos, ranker: ranker.provides.ranker });
export type RankDeps = DepsOf<typeof rankDeps>;

const rankLogic = rankDeps.usecases({ top });

export const rank = rankLogic.provides({ ranking: ({ usecases }) => ({ top: usecases.top }) }).entrypoints();
