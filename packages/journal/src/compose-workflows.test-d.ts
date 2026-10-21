import { describe, it } from 'vitest';
import { z } from 'zod';

import { need } from './handlers.js';
import { j } from './test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
// A workflow's needs are checked by `compose` the way an effect's are: a missing service would otherwise compile and
// only fail at runtime (`BAD_DEFINITION`), the first time a worker ran the step.
type Provider = { refund(id: string): Promise<{ id: string }> };
const provider: Provider = { refund: id => Promise.resolve({ id }) };
const workflowMeta = { actorId: 'system' };
const refund = j
  .workflow('refund', { version: 1, input: z.object({ id: z.string() }), needs: { provider: need<Provider>() } })
  .step('pay', ({ provider: given, input }) => given.refund(input.id))
  .finish();
const plain = j
  .workflow('plain', { version: 1, input: z.object({}) })
  .step('one', () => 1)
  .finish();

describe('compose with workflows, as types', () => {
  it('compiles when services give every need of every workflow', () => {
    j.compose({ workflows: [refund, plain], workflowMeta, services: { provider } });
  });

  it('refuses a workflow whose need has no service', () => {
    // @ts-expect-error -- `refund` needs `provider`, so `compose` without `services` must not compile
    j.compose({ workflows: [refund], workflowMeta });
    // @ts-expect-error -- the service is there, but it is not a `Provider`
    j.compose({ workflows: [refund], workflowMeta, services: { provider: { refund: 1 } } });
  });

  it("leaves the needs to the worker with services: 'worker', as for effects", () => {
    j.compose({ workflows: [refund], workflowMeta, services: 'worker' });
  });

  it('asks for nothing when no workflow needs anything', () => {
    j.compose({ workflows: [plain], workflowMeta });
  });
});
