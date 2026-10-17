import { group } from '../../../src/index.js';
import { groupDescribe } from '../tree-data.js';

export default group(groupDescribe('billing'), {
  list: () => import('./billing/list.js'),
  show: () => import('./billing/show.js'),
  create: () => import('./billing/create.js'),
  sync: () => import('./billing/sync.js'),
  run: () => import('./billing/run.js'),
});
