import { describe } from 'vitest';

import { memoryStore } from '../memory.js';
import { chaos } from './chaos.js';
import { describeCases, describeStoreContract } from './index.js';
import { replicaCases } from './replicas.js';

describeStoreContract('memory', () => memoryStore());

describe('memory chaos and replicas', () => {
  describeCases(
    'chaos hooks (none supplied: all skip with a reason)',
    chaos(() => memoryStore(), {}),
  );
  describeCases(
    'replicas',
    replicaCases(() => memoryStore()),
  );
});
