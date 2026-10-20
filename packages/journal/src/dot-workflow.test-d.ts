import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFeature, feature } from '@arki/dot/feature';
import { service } from '@arki/dot/plugin';

import { journalHandlers, journalWorkflows } from './dot.js';
import { need } from './handlers.js';
import { initJournal } from './journal.js';
import { tables } from './test-support.js';

type Provider = { readonly name: string };

const wj = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const needy = wj
  .workflow('types.needy', { version: 1, input: z.object({}), needs: { provider: need<Provider>() } })
  .step('call', ({ provider }) => provider.name)
  .finish();
const plain = wj
  .workflow('types.plain', { version: 1, input: z.object({}) })
  .step('a', () => 1)
  .finish();

describe("a workflow's needs are read from its definition", () => {
  it('a feature that declares a workflow must have the services its needs name', () => {
    // @ts-expect-error -- the feature has no `provider` need, but the workflow needs one
    const refused = feature('bare', { use: [journalHandlers({ workflows: [needy] })] });
    const given = feature('given', {
      needs: { provider: service<Provider>() },
      use: [journalHandlers({ workflows: [needy] })],
    });
    expectTypeOf(refused.name).toBeString();
    expectTypeOf(given.name).toBeString();
  });

  it('a workflow with no needs asks the feature for nothing', () => {
    const free = feature('free', { use: [journalHandlers({ workflows: [plain] })] });
    expectTypeOf(free.name).toBeString();
  });

  it('journalWorkflows(core, defs) checks the needs against the core', () => {
    const bare = defineFeature('bare-core').usecases({});
    // @ts-expect-error -- `bare-core` has no `provider` need, infra service or usecase
    const refused = () => journalWorkflows(bare, [needy]);
    expectTypeOf(refused).toBeFunction();
  });
});
