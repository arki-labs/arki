import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('cache'), {
  list: () => import('./cache/list.js'),
  show: () => import('./cache/show.js'),
  create: () => import('./cache/create.js'),
  sync: () => import('./cache/sync.js'),
  run: () => import('./cache/run.js'),
});
