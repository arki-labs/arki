/**
 * The oRPC adapter: what an API client sees when a command fails. An app adds
 * `commandErrors()` to its procedure builders once, and every rejected rule
 * answers with its own code and message instead of a 500. The procedures here
 * are real oRPC procedures, called the way oRPC calls them on the server.
 */
import { call, ORPCError, os } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import { TransactionDefect } from '@arki/db/errors';
import { defineFailure } from '@arki/failure';
import { errorMap, orThrowRpc } from '@arki/failure/orpc';

import type { CommandFailure } from './errors.js';
import { CommandConflict, CommandForbidden, CommandInvalid, CommandNotFound, JournalError } from './errors.js';
import { commandErrors, orThrowCommand, toORPCError } from './orpc.js';

const RETRY_MESSAGE = 'This was changed by another request. Reload the current state and try again.';

/** What an app's own outermost error middleware does: an `ORPCError` passes, everything else is a 500. */
const appErrors = os.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'An unexpected internal server error occurred.' });
  }
});

/** A procedure whose handler throws `thrown`, called like a request would call it. */
const answerOf = (builder: Pick<typeof os, 'handler'>, thrown: unknown): Promise<unknown> =>
  call(
    builder.handler(() => {
      throw thrown;
    }),
    {},
  ).catch((error: unknown) => error);

/** A procedure whose handler returns `returned`, called like a request would call it: the answer or the error. */
const resultOf = (builder: Pick<typeof os, 'handler'>, returned: unknown): Promise<unknown> =>
  call(
    builder.handler(() => returned),
    {},
  ).catch((error: unknown) => error);

describe('toORPCError', () => {
  it.each([
    [CommandNotFound({ detail: 'Order not found' }), 'journal.not_found', 404],
    [CommandInvalid({ detail: 'Pick a later date' }), 'journal.invalid', 400],
    [CommandForbidden({ detail: 'Not your order' }), 'journal.forbidden', 403],
    [CommandConflict({ detail: 'Order is already paid' }), 'journal.conflict', 409],
  ])(
    'turns a returned %o into the ORPCError with its code, status, message and data, so the client reads the rule that said no',
    (failure, code, status) => {
      const mapped = toORPCError(failure);

      expect(mapped).toBeInstanceOf(ORPCError);
      expect(mapped).toMatchObject({ code, status, message: failure.message, data: { detail: failure.message } });
    },
  );

  it('turns a journal CONFLICT into a 409 that asks to try again, so a lost race is not a 500 and no entity id leaks', () => {
    const lost = new JournalError('CONFLICT', 'order', 'ord_secret', 'version 3 already exists');

    const mapped = toORPCError(lost);

    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped).toMatchObject({ code: 'CONFLICT', status: 409, message: RETRY_MESSAGE });
  });

  it('turns the TransactionDefect a command run returns for a journal CONFLICT into the same 409, so a stale version is not a 500', () => {
    const returned = TransactionDefect({
      cause: new JournalError('CONFLICT', 'order', 'ord_secret', 'version 3 already exists'),
    });

    const mapped = toORPCError(returned);

    expect(mapped).toMatchObject({ code: 'CONFLICT', status: 409, message: RETRY_MESSAGE });
    expect(JSON.stringify(mapped)).not.toContain('ord_secret');
  });

  it('keeps any other TransactionDefect as the failure it is, because only a CONFLICT is safe to retry', () => {
    const returned = TransactionDefect({ cause: new JournalError('NO_ROW', 'order', 'ord_1') });

    expect(toORPCError(returned)).toMatchObject({ code: TransactionDefect.code, status: returned.status });
  });

  it('does not carry the original error along, because a host may log or serialize `cause` and the journal message names the entity id', () => {
    const lost = new JournalError('CONFLICT', 'order', 'ord_secret', 'version 3 already exists');
    const rejected = CommandForbidden({ detail: 'Not your order' });

    const causeOf = (mapped: unknown) => (mapped instanceof Error ? mapped.cause : 'not an error');

    expect(causeOf(toORPCError(lost))).toBeUndefined();
    expect(causeOf(toORPCError(rejected))).toBeUndefined();
    expect(JSON.stringify(toORPCError(lost))).not.toContain('ord_secret');
  });

  it('returns anything else unchanged, so the app decides what an unknown failure means', () => {
    const boom = new Error('database is down');
    const noRow = new JournalError('NO_ROW', 'order', 'ord_1');
    const already = new ORPCError('UNAUTHORIZED', { message: 'You must be logged in' });

    expect(toORPCError(boom)).toBe(boom);
    expect(toORPCError(noRow)).toBe(noRow);
    expect(toORPCError(already)).toBe(already);
    expect(toORPCError('not an error')).toBe('not an error');
  });
});

describe('commandErrors()', () => {
  it('answers a thrown failure with its code, status and message, so procedures need no try/catch around a command', async () => {
    const answer = await answerOf(os.use(commandErrors()), CommandForbidden({ detail: 'You do not own this session' }));

    expect(answer).toBeInstanceOf(ORPCError);
    expect(answer).toMatchObject({ code: 'journal.forbidden', status: 403, message: 'You do not own this session' });
  });

  it('answers a journal CONFLICT with a 409 the client can retry', async () => {
    const answer = await answerOf(os.use(commandErrors()), new JournalError('CONFLICT', 'order', 'ord_1'));

    expect(answer).toBeInstanceOf(ORPCError);
    expect(answer).toMatchObject({ code: 'CONFLICT', status: 409, message: RETRY_MESSAGE });
  });

  it('leaves an unknown error alone, so it still reaches the app as the error that was thrown', async () => {
    const boom = new Error('database is down');

    expect(await answerOf(os.use(commandErrors()), boom)).toBe(boom);
  });

  it('answers a returned failure as an error, never as a success the client would take for done', async () => {
    const answer = await resultOf(os.use(commandErrors()), CommandConflict({ detail: 'Order is already paid' }));

    expect(answer).toBeInstanceOf(ORPCError);
    expect(answer).toMatchObject({ code: 'journal.conflict', status: 409, message: 'Order is already paid' });
  });

  it('a contract that lists the failure with errorMap gets it as a declared error through orThrowRpc', async () => {
    // The recommended form for a contract-first procedure: the client gets it typed (`defined: true`).
    const procedure = os
      .errors(errorMap(CommandNotFound))
      .use(commandErrors())
      .handler(({ errors }) => orThrowRpc(Promise.resolve(CommandNotFound({ detail: 'Order not found' })), errors));

    const answer = await call(procedure, {}).catch((error: unknown) => error);

    expect(answer).toMatchObject({ code: 'journal.not_found', status: 404, message: 'Order not found', defined: true });
  });

  it('lets the handler result through untouched', async () => {
    const procedure = os.use(commandErrors()).handler(() => ({ ok: true }));

    await expect(call(procedure, {})).resolves.toEqual({ ok: true });
  });

  it('placed inside the app error middleware, a rejected rule is not re-wrapped into a 500 and an unknown error still is', async () => {
    const builder = os.use(appErrors).use(commandErrors());

    expect(await answerOf(builder, CommandConflict({ detail: 'Username is already taken' }))).toMatchObject({
      code: 'journal.conflict',
      status: 409,
      message: 'Username is already taken',
    });
    expect(await answerOf(builder, new Error('database is down'))).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      status: 500,
    });
  });

  it('placed outside the app error middleware it is too late: the rule is already a 500, which is why the order matters', async () => {
    const builder = os.use(commandErrors()).use(appErrors);

    expect(await answerOf(builder, CommandConflict({ detail: 'Username is already taken' }))).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('orThrowCommand(result, errors)', () => {
  // Why: a contract-first procedure that runs a command lists its business failures. The journal's own
  // failures (bad input, a lost race, a failed transaction) belong to every command: making each contract
  // list them would be noise, and leaving them out must still answer the client correctly, never as a 500.
  const OrderRefused = defineFailure('orders.refused', { status: 422, message: 'This customer cannot order.' });
  type Ran = { readonly id: string } | ReturnType<typeof OrderRefused> | CommandFailure;
  const answerFor = (ran: Ran): Promise<unknown> =>
    call(
      os.errors(errorMap(OrderRefused)).handler(({ errors }) => orThrowCommand(Promise.resolve(ran), errors)),
      {},
    ).catch((error: unknown) => error);

  it("returns the command's value", async () => {
    expect(await answerFor({ id: 'ord_1' })).toEqual({ id: 'ord_1' });
  });

  it("throws a business failure the contract lists as the contract's typed error, the failure kept as its cause", async () => {
    // The cause stays on the server (oRPC never sends it): observers read the failure, as with `orThrowRpc`.
    expect(await answerFor(OrderRefused())).toMatchObject({
      code: 'orders.refused',
      status: 422,
      defined: true,
      cause: { code: 'orders.refused' },
    });
  });

  it('answers a lost race with the retryable 409 CONFLICT, though the contract does not list it', async () => {
    const lost = TransactionDefect({ cause: new JournalError('CONFLICT', 'order', 'ord_secret', 'version 3 exists') });
    const answer = await answerFor(lost);
    expect(answer).toMatchObject({ code: 'CONFLICT', status: 409, message: RETRY_MESSAGE });
    expect(JSON.stringify(answer)).not.toContain('ord_secret');
  });

  it('answers another journal failure with its own code and status, as an undeclared error', async () => {
    expect(await answerFor(CommandConflict({ detail: 'Order already exists' }))).toMatchObject({
      code: 'journal.conflict',
      status: 409,
      defined: false,
    });
  });

  it('refuses at compile time a business failure the contract does not list', () => {
    const unlisted = os.handler(({ errors }) =>
      // @ts-expect-error -- `orders.refused` is a business failure, and this contract does not list it
      orThrowCommand(Promise.resolve<Ran>(OrderRefused()), errors),
    );
    expect(unlisted).toBeDefined();
  });
});
