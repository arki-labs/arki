import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('search'), {
  list: () => import('./search/list.js'),
  show: () => import('./search/show.js'),
  create: () => import('./search/create.js'),
  sync: () => import('./search/sync.js'),
  run: () => import('./search/run.js'),
});
