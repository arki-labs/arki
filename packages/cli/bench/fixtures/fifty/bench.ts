import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('bench'), {
  list: () => import('./bench/list.js'),
  show: () => import('./bench/show.js'),
  create: () => import('./bench/create.js'),
  sync: () => import('./bench/sync.js'),
  run: () => import('./bench/run.js'),
});
