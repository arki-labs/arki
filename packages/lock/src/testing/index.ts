/** `@arki/lock/testing`: a manual scheduler, the store conformance suite, chaos hooks and the replica property. */
import { describe, it } from 'vitest';

import type { ContractCase, ContractOptions, MakeStore } from './contract.js';
import { ContractSkip, storeContract } from './contract.js';

export { memoryStore } from '../memory.js';
export type { MemoryEntry, MemoryGuarantees, MemoryStore } from '../memory.js';
export { chaos } from './chaos.js';
export type { ChaosHooks } from './chaos.js';
export { ContractSkip, storeContract } from './contract.js';
export type { ContractCase, ContractOptions, MakeStore } from './contract.js';
export { manualScheduler } from './manual-scheduler.js';
export type { ManualScheduler } from './manual-scheduler.js';
export { replicaCases } from './replicas.js';
export type { ReplicaOptions } from './replicas.js';

/** Register cases with vitest; a case that throws {@link ContractSkip} is reported skipped with its reason. */
export function describeCases(name: string, cases: readonly ContractCase[]): void {
  describe(name, () => {
    for (const contractCase of cases) {
      it(contractCase.name, async context => {
        try {
          await contractCase.run();
        } catch (error) {
          if (error instanceof ContractSkip) context.skip(error.message);
          throw error;
        }
      });
    }
  });
}

/** `storeContract` wrapped in a vitest `describe`. */
export function describeStoreContract(name: string, makeStore: MakeStore, options: ContractOptions = {}): void {
  describeCases(`${name} store contract`, storeContract(makeStore, options));
}
