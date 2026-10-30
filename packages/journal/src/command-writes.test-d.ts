import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { IdGenerationFailure } from '@arki/contracts';
import type { SchemaFailure } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { CommandFailure } from './errors.js';
import type { AnyEventDef, Command, CommandContext, CommandWrite, DbHandle, EventsOf, WriteResult } from './index.js';
import type { orders } from './test-support.js';
import { CommandNotFound } from './index.js';
import { j, meta, order, orderId, OrderNoted, OrderPaid } from './test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const journal = j.compose({});
declare const db: Parameters<typeof journal.jobs>[0];
type MetaOut = { actorId: string };
const idInput = z.object({ id: z.templateLiteral(['ord_', z.string()]) });

describe('a command declares the events it writes', () => {
  it('write takes the declared events and refuses any other', () => {
    j.command('declared', idInput, { writes: [OrderPaid] }, (input, { write }) =>
      write(order, input.id, () => [OrderPaid({ amount: 1 })]),
    );
    j.command('undeclared', idInput, { writes: [OrderPaid] }, (input, { write }) =>
      // @ts-expect-error OrderNoted is not in `writes`.
      write(order, input.id, () => [OrderNoted({ note: 'n' })]),
    );
    j.command('undeclared-async', idInput, { writes: [OrderPaid] }, (input, { write }) =>
      // @ts-expect-error the list holds for an async `events` too.
      write(order, input.id, () => Promise.resolve([OrderNoted({ note: 'n' })])),
    );
  });

  it('writes: [] is a command that only runs children, and write takes no event', () => {
    const child = j.command('child', idInput, { writes: [OrderPaid] }, (input, { write }) =>
      write(order, input.id, () => [OrderPaid({ amount: 1 })]),
    );
    const parent = j.command('parent', idInput, { writes: [] }, (input, { run }) => run(child, input));
    expectTypeOf(parent.writes).toEqualTypeOf<readonly []>();
    j.command('parent-writes', idInput, { writes: [] }, (input, { write }) =>
      // @ts-expect-error `writes: []` declares nothing.
      write(order, input.id, () => [OrderPaid({ amount: 1 })]),
    );
  });

  it('writes is required, and the old argument order is gone', () => {
    // @ts-expect-error the handler is the fourth argument now.
    j.command('no-options', idInput, () => 1);
    // @ts-expect-error `writes` is required.
    j.command('no-writes', idInput, {}, () => 1);
    // @ts-expect-error `authorize` does not replace `writes`.
    j.command('only-authorize', idInput, { authorize: () => CommandNotFound({ detail: 'no' }) }, () => 1);
    j.command(
      'old-order',
      idInput,
      // @ts-expect-error the options no longer come after the handler.
      () => 1,
      { writes: [] },
    );
  });

  it('writes keeps the exact tuple on the command value', () => {
    const both = j.command('both', idInput, { writes: [OrderPaid, OrderNoted] }, () => 1);
    expectTypeOf(both.writes).toEqualTypeOf<readonly [typeof OrderPaid, typeof OrderNoted]>();
    expectTypeOf(both).toExtend<Command<typeof idInput, number, MetaOut>>();
    expectTypeOf<Command<typeof idInput, number, MetaOut>['writes']>().toEqualTypeOf<readonly AnyEventDef[]>();
  });

  it('the failure union and the result stay inferred', async () => {
    const Forbidden = defineFailure('test.forbidden');
    const pay = j.command(
      'pay',
      idInput,
      {
        writes: [OrderPaid],
        authorize: (input, context) => (input.id === context.meta.actorId ? undefined : Forbidden()),
      },
      (input, { write }) =>
        write(order, input.id, row =>
          row === null ? CommandNotFound({ detail: 'no order' }) : [OrderPaid({ amount: 1 })],
        ),
    );
    const result = await journal.run(db, pay, { id: orderId(1) }, meta);
    type Expected =
      | WriteResult<typeof orders, EventsOf<typeof order>, MetaOut>
      | CommandNotFound
      | SchemaFailure
      | IdGenerationFailure
      | ReturnType<typeof Forbidden>
      | CommandFailure;
    expectTypeOf(result).toEqualTypeOf<Expected>();
  });

  it('authorize types against the input and the meta, from the options object', () => {
    j.command(
      'guarded',
      idInput,
      {
        writes: [],
        authorize: (input, context) => {
          expectTypeOf(input).toEqualTypeOf<{ id: `ord_${string}` }>();
          expectTypeOf(context.meta).toEqualTypeOf<MetaOut>();
          expectTypeOf(context.tx).toEqualTypeOf<DbHandle>();
        },
      },
      () => 1,
    );
  });

  it('a helper names what it writes, and a command must declare at least that', () => {
    const paid = (write: CommandWrite<MetaOut, DbHandle, typeof OrderPaid>) =>
      write(order, orderId(1), () => [OrderPaid({ amount: 1 })]);
    const paidThroughContext = ({ write }: Pick<CommandContext<MetaOut, DbHandle, typeof OrderPaid>, 'write'>) =>
      paid(write);
    const anything = (write: CommandWrite<MetaOut>) => write(order, orderId(1), () => [OrderPaid({ amount: 1 })]);
    j.command('wider', idInput, { writes: [OrderPaid, OrderNoted] }, (_input, context) => [
      paid(context.write),
      paidThroughContext(context),
    ]);
    j.command('narrower', idInput, { writes: [OrderNoted] }, (_input, context) => [
      // @ts-expect-error the helper writes OrderPaid, which this command does not declare.
      paid(context.write),
      // @ts-expect-error the same through the context.
      paidThroughContext(context),
    ]);
    // @ts-expect-error a helper typed for every event cannot take a command's narrower `write`.
    j.command('loose', idInput, { writes: [OrderPaid] }, (_input, { write }) => anything(write));
  });
});
