import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('media'), {
  list: () => import('./media/list.js'),
  show: () => import('./media/show.js'),
  create: () => import('./media/create.js'),
  sync: () => import('./media/sync.js'),
  run: () => import('./media/run.js'),
});
