import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('users'), {
  list: () => import('./users/list.js'),
  show: () => import('./users/show.js'),
  create: () => import('./users/create.js'),
  sync: () => import('./users/sync.js'),
  run: () => import('./users/run.js'),
});
