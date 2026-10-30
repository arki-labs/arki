import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { DepsOf } from '@arki/dot/feature';
import { defineFeature } from '@arki/dot/feature';
import { service } from '@arki/dot/unit';

import { journalHandlers, needsOf } from './dot.js';
import { initJournal } from './journal.js';
import { tables } from './test-support.js';

type Provider = { readonly name: string };

const wj = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const givenCore = defineFeature('given').needs({ provider: service<Provider>() });
const needy = wj
  .workflow('types.needy', { version: 1, input: z.object({}), needs: needsOf((_: DepsOf<typeof givenCore>) => ['provider']) })
  .step('call', ({ provider }) => {
    expectTypeOf(provider).toEqualTypeOf<Provider>();
    return provider.name;
  })
  .finish();
const plain = wj
  .workflow('types.plain', { version: 1, input: z.object({}) })
  .step('a', () => 1)
  .finish();

describe("a workflow's needs are read from its definition", () => {
  it('a feature that declares a workflow must have the services its needs name', () => {
    const bare = defineFeature('bare');
    // @ts-expect-error -- the feature has no `provider` need, but the workflow needs one
    const refused = bare.usecases({}, journalHandlers(bare, { workflows: [needy] })).entrypoints();
    const given = givenCore.usecases({}, journalHandlers(givenCore, { workflows: [needy] })).entrypoints();
    expectTypeOf(refused.name).toBeString();
    expectTypeOf(given.name).toBeString();
  });

  it('a workflow with no needs asks the feature for nothing', () => {
    const freeCore = defineFeature('free');
    const free = freeCore.usecases({}, journalHandlers(freeCore, { workflows: [plain] })).entrypoints();
    expectTypeOf(free.name).toBeString();
  });
});
