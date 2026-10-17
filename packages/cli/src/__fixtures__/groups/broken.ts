import { imported } from '../tree.js';

imported('broken');

function explode(): never {
  throw new Error('broken.ts must never be imported by help or --version');
}

export default explode();
