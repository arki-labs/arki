import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('deploy'), {
  list: () => import('./deploy/list.js'),
  show: () => import('./deploy/show.js'),
  create: () => import('./deploy/create.js'),
  sync: () => import('./deploy/sync.js'),
  run: () => import('./deploy/run.js'),
});
