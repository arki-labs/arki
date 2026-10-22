/**
 * `with: [...]` on a command at runtime.
 *
 * Why these tests exist: a step's refusal must be the command's failure, written exactly as a Failure
 * returned from `run` is (same exit code, same error envelope), and `run` must not start. What a step
 * returns must be on `run`'s context, and an earlier step's additions must be visible to a later one.
 * An around must wrap everything listed after it, later steps and `run`, and pass the result through,
 * so a transaction can own them. The step/around split reads `fn.length`; the tests pin it.
 */
import { describe, expect, it, vi } from 'vitest';

import { defineFailure } from '@arki/failure';

import type { AnyCommand } from './command.js';
import { capture, envelopeOf, json } from './__fixtures__/capture.js';
import { defineCli } from './cli.js';
import { defineCommand } from './command.js';
import { isAround } from './with.js';

const SignInRequired = defineFailure('test.with.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.with.not_admin', { status: 403 });

type Principal = { readonly user: { readonly id: string; readonly email: string } };
const ada: Principal = { user: { id: 'usr_ada', email: 'ada@arki.dev' } };
const bob: Principal = { user: { id: 'usr_bob', email: 'bob@example.com' } };

const asPrincipal = (principal: Principal | null) => () => (principal === null ? SignInRequired() : { principal });
const admin = (ctx: { readonly principal: Principal }) =>
  Promise.resolve(ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin());

const cliWith = (command: AnyCommand) => defineCli({ name: 'tool', version: '1.0.0', commands: { go: command } });

const adminProgram = (principal: Principal) =>
  cliWith(
    defineCommand({
      describe: 'go',
      with: [asPrincipal(principal), admin],
      run: ctx => ({ user: ctx.principal.user.id, isAdmin: ctx.isAdmin }),
    }),
  );

describe('step', () => {
  it('a refusal is written exactly like a Failure returned from run, and run never starts', async () => {
    const run = vi.fn(() => 'ran');
    const refused = await capture(
      cliWith(defineCommand({ describe: 'go', with: [asPrincipal(null)], run: () => run() })),
      ['go'],
    );
    const returned = await capture(cliWith(defineCommand({ describe: 'go', run: () => SignInRequired() })), ['go']);
    expect(refused.exitCode).toBe(returned.exitCode);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toBe(returned.stderr);
    expect(envelopeOf(refused.stdout)).toEqual(envelopeOf(returned.stdout));
    expect(json(refused.stdout)).toMatchObject({ ok: false, error: { code: 'test.with.sign_in' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('what a step returns reaches run', async () => {
    const { exitCode, stdout } = await capture(
      cliWith(defineCommand({ describe: 'go', with: [asPrincipal(ada)], run: ctx => ({ id: ctx.principal.user.id }) })),
      ['go'],
    );
    expect(exitCode).toBe(0);
    expect(json(stdout)).toMatchObject({ ok: true, data: { id: 'usr_ada' } });
  });

  it('a later step reads what the earlier step added, and may refuse with its own failure', async () => {
    const allowed = await capture(adminProgram(ada), ['go']);
    expect(json(allowed.stdout)).toMatchObject({ data: { user: 'usr_ada', isAdmin: true } });
    const refused = await capture(adminProgram(bob), ['go']);
    expect(refused.exitCode).not.toBe(0);
    expect(json(refused.stdout)).toMatchObject({ error: { code: 'test.with.not_admin' } });
  });

  it('wraps --dry-run too: preview gets the same context', async () => {
    const { exitCode, stdout } = await capture(
      cliWith(
        defineCommand({
          describe: 'go',
          with: [asPrincipal(ada)],
          preview: ctx => ({ would: ctx.principal.user.id }),
          run: ctx => ({ would: ctx.principal.user.id }),
        }),
      ),
      ['go', '--dry-run'],
    );
    expect(exitCode).toBe(0);
    expect(json(stdout)).toMatchObject({ data: { would: 'usr_ada' } });
  });

  it('a command without `with` behaves as before', async () => {
    const { exitCode, stdout } = await capture(cliWith(defineCommand({ describe: 'go', run: () => 7 })), ['go']);
    expect(exitCode).toBe(0);
    expect(json(stdout)).toMatchObject({ data: 7 });
  });
});

const tracedProgram = (events: string[], options: { readonly refuse?: boolean; readonly throws?: boolean } = {}) => {
  const recorded = async <T>(_ctx: object, next: () => Promise<T>) => {
    events.push('open');
    try {
      const result = await next();
      events.push('commit');
      return result;
    } catch (error) {
      events.push('rollback');
      throw error;
    }
  };
  const later = () => {
    events.push('step');
    return options.refuse === true ? SignInRequired() : { later: true as const };
  };
  return cliWith(
    defineCommand({
      describe: 'go',
      with: [recorded, later],
      run: () => {
        events.push('run');
        if (options.throws === true) throw new Error('boom');
        return { done: true };
      },
    }),
  );
};

describe('around', () => {
  it('wraps later steps and run, and the result passes through', async () => {
    const events: string[] = [];
    const { exitCode, stdout } = await capture(tracedProgram(events), ['go']);
    expect(events).toEqual(['open', 'step', 'run', 'commit']);
    expect(exitCode).toBe(0);
    expect(json(stdout)).toMatchObject({ data: { done: true } });
  });

  it('sees a later refusal as the value next() resolves to; run never starts', async () => {
    const events: string[] = [];
    const { exitCode, stdout } = await capture(tracedProgram(events, { refuse: true }), ['go']);
    expect(events).toEqual(['open', 'step', 'commit']);
    expect(exitCode).not.toBe(0);
    expect(json(stdout)).toMatchObject({ error: { code: 'test.with.sign_in' } });
  });

  it('sees a thrown error, so a transaction rolls back; the CLI reports it as a bug', async () => {
    const events: string[] = [];
    const { exitCode, stdout } = await capture(tracedProgram(events, { throws: true }), ['go']);
    expect(events).toEqual(['open', 'step', 'run', 'rollback']);
    expect(exitCode).not.toBe(0);
    expect(json(stdout)).toMatchObject({ ok: false });
  });
});

// Same shape as `(ctx, next = fallback) => ...`: the default makes `.length` stop before it.
const withDefault = async (_ctx: object, next: () => Promise<unknown> = () => Promise.resolve(0)) => next();

describe('the step / around split reads fn.length', () => {
  it('an element that declares `next` is an around; one that does not is a step', () => {
    expect(isAround((_ctx: object) => ({}))).toBe(false);
    expect(isAround(() => ({}))).toBe(false);
    expect(isAround(async <T>(_ctx: object, next: () => Promise<T>) => next())).toBe(true);
  });

  it('an inline around runs as an around', async () => {
    const events: string[] = [];
    const program = cliWith(
      defineCommand({
        describe: 'go',
        with: [
          async <T>(_ctx: object, next: () => Promise<T>) => {
            events.push('before');
            const result = await next();
            events.push('after');
            return result;
          },
        ],
        run: () => {
          events.push('run');
          return 1;
        },
      }),
    );
    await capture(program, ['go']);
    expect(events).toEqual(['before', 'run', 'after']);
  });

  it('a default value hides a parameter from fn.length: an around that defaults `next` is taken for a step (what an author must not write)', () => {
    expect(withDefault.length).toBe(1);
    expect(isAround(withDefault)).toBe(false);
  });
});
