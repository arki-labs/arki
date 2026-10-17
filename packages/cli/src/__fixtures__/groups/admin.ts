import { group } from '../../tree.js';
import { imported } from '../tree.js';

imported('admin');

export default group('Administration', {
  broken: () => import('./broken.js'),
});
