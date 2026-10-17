import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('jobs'), {
  list: () => import('./jobs/list.js'),
  show: () => import('./jobs/show.js'),
  create: () => import('./jobs/create.js'),
  sync: () => import('./jobs/sync.js'),
  run: () => import('./jobs/run.js'),
});
