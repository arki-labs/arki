/**
 * The oRPC adapter: what an API client sees when a command fails. An app adds
 * `commandErrors()` to its procedure builders once, and every rejected rule
 * answers with its own code and message instead of a 500. The procedures here
 * are real oRPC procedures, called the way oRPC calls them on the server.
 */
import { call, ORPCError, os } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import type { CommandErrorCode } from './errors.js';
import { CommandError, JournalError } from './errors.js';
import { commandErrors, toORPCError } from './orpc.js';

const RETRY_MESSAGE = 'This was changed by another request at the same time. Please try again.';

const STATUS: Record<CommandErrorCode, number> = { BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 };

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

describe('toORPCError', () => {
  it.each(Object.entries(STATUS))(
    'turns a CommandError %s into the ORPCError with the same code and message, so the client reads the rule that rejected it',
    (code, status) => {
      const rejected = new CommandError(code as CommandErrorCode, 'Session already started');

      const mapped = toORPCError(rejected);

      expect(mapped).toBeInstanceOf(ORPCError);
      expect(mapped).toMatchObject({ code, status, message: 'Session already started' });
    },
  );

  it('turns a journal CONFLICT into a 409 that asks to try again, so a lost race is not a 500 and no entity id leaks', () => {
    const lost = new JournalError('CONFLICT', 'order', 'ord_secret', 'version 3 already exists');

    const mapped = toORPCError(lost);

    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped).toMatchObject({ code: 'CONFLICT', status: 409, message: RETRY_MESSAGE });
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
  it('answers a rejected rule with its code and message, so procedures need no try/catch around a command', async () => {
    const answer = await answerOf(
      os.use(commandErrors()),
      new CommandError('FORBIDDEN', 'You do not own this session'),
    );

    expect(answer).toBeInstanceOf(ORPCError);
    expect(answer).toMatchObject({ code: 'FORBIDDEN', status: 403, message: 'You do not own this session' });
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

  it('lets the handler result through untouched', async () => {
    const procedure = os.use(commandErrors()).handler(() => ({ ok: true }));

    await expect(call(procedure, {})).resolves.toEqual({ ok: true });
  });

  it('placed inside the app error middleware, a rejected rule is not re-wrapped into a 500 and an unknown error still is', async () => {
    const builder = os.use(appErrors).use(commandErrors());

    expect(await answerOf(builder, new CommandError('CONFLICT', 'Username is already taken'))).toMatchObject({
      code: 'CONFLICT',
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

    expect(await answerOf(builder, new CommandError('CONFLICT', 'Username is already taken'))).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
