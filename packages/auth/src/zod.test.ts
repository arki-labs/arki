import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdGenerationFailure, z } from '@arki/contracts';
import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { AccountId, SessionId, UserId, VerificationId } from './ids.js';
import { createAccountId, createSessionId, createUserId, createVerificationId } from './ids.js';
import { teamIdSchema, userIdSchema } from './zod.js';

afterEach(() => vi.unstubAllGlobals());

// Apps put these schemas in oRPC inputs. The input must stay `string`, so a client that holds a
// plain string still typechecks; the output is the id type, so the handler gets a typed id.
describe('@arki/auth/zod id schemas', () => {
  it('take a string and give the id type', () => {
    expectTypeOf<z.input<typeof userIdSchema>>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof userIdSchema>>().toEqualTypeOf<UserId>();
    expectTypeOf(createUserId).returns.toEqualTypeOf<UserId | IdGenerationFailure>();
    expectTypeOf(createSessionId).returns.toEqualTypeOf<SessionId | IdGenerationFailure>();
    expectTypeOf(createAccountId).returns.toEqualTypeOf<AccountId | IdGenerationFailure>();
    expectTypeOf(createVerificationId).returns.toEqualTypeOf<VerificationId | IdGenerationFailure>();
  });

  it('accept an id of their kind, made by ./ids', () => {
    const id = orThrow(createUserId());
    expect(userIdSchema.parse(id)).toBe(id);
  });

  it('refuse an id of another kind, naming the prefix they wanted', () => {
    const result = userIdSchema.safeParse('sess_abc');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Expected an id starting with "usr_"');
    expect(teamIdSchema.safeParse('team_abc').success).toBe(true);
  });

  it('keeps unavailable entropy visible through every public auth generator', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- Vitest requires the replacement value to remove this provider.
    vi.stubGlobal('crypto', undefined);
    for (const create of [createUserId, createSessionId, createAccountId, createVerificationId]) {
      expect(RandomSourceUnavailable.is(create())).toBe(true);
    }
  });

  it('retains a broken entropy provider as a private defect', () => {
    const cause = new Error('private entropy detail');
    vi.stubGlobal('crypto', {
      getRandomValues() {
        throw cause;
      },
    });
    const result = createUserId();
    expect(UnexpectedDefect.is(result) && result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain(cause.message);
  });
});
