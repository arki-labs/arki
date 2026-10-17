import { describe, expect, expectTypeOf, it } from 'vitest';

import type { z } from '@arki/contracts';

import type { UserId } from './ids.js';
import { createUserId } from './ids.js';
import { teamIdSchema, userIdSchema } from './zod.js';

// Apps put these schemas in oRPC inputs. The input must stay `string`, so a client that holds a
// plain string still typechecks; the output is the id type, so the handler gets a typed id.
describe('@arki/auth/zod id schemas', () => {
  it('take a string and give the id type', () => {
    expectTypeOf<z.input<typeof userIdSchema>>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof userIdSchema>>().toEqualTypeOf<UserId>();
  });

  it('accept an id of their kind, made by ./ids', () => {
    const id = createUserId();
    expect(userIdSchema.parse(id)).toBe(id);
  });

  it('refuse an id of another kind, naming the prefix they wanted', () => {
    const result = userIdSchema.safeParse('sess_abc');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Expected an id starting with "usr_"');
    expect(teamIdSchema.safeParse('team_abc').success).toBe(true);
  });
});
