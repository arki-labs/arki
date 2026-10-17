import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('admin'), {
  list: () => import('./admin/list.js'),
  show: () => import('./admin/show.js'),
  create: () => import('./admin/create.js'),
  sync: () => import('./admin/sync.js'),
  run: () => import('./admin/run.js'),
});
