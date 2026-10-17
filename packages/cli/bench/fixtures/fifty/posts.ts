import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('posts'), {
  list: () => import('./posts/list.js'),
  show: () => import('./posts/show.js'),
  create: () => import('./posts/create.js'),
  sync: () => import('./posts/sync.js'),
  run: () => import('./posts/run.js'),
});
