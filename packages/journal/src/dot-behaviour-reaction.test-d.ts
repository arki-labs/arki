/**
 * reactions/send-receipt.ts of the behaviour module in `dot-behaviour.test-d.ts`: the reaction the
 * behaviour owns. It imports the feature's `Deps` as a type only, so the feature may import this file.
 */
import { expectTypeOf } from 'vitest';

import type { Deps, Mailer } from './dot-behaviour.test-d.js';
import type { EffectContext } from './types.js';
import { needsOf } from './dot.js';
import { j, order } from './test-support.js';

export const sendReceipt = j.effect('send-receipt', order, needsOf((_: Deps) => ['mailer']), {
  OrderPlaced: (event, ctx) => {
    // Exactly the picked deps on top of the effect's own context: no `pricing`, no `db` from the feature.
    expectTypeOf<Omit<typeof ctx, keyof EffectContext>>().toEqualTypeOf<{ readonly mailer: Mailer }>();
    return ctx.mailer.sendReceipt(event.entityId);
  },
});
