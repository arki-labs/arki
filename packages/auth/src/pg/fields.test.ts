/**
 * The engine learns the exposed columns from the table. If this mapping drifts, the engine would
 * demand a column the app fills itself, or let a client write a server-owned column.
 */
import { bigint, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { AUTH_ERROR_CODES } from '../errors.js';
import { additionalFieldsFromColumns } from './fields.js';

const Users = pgTable('users', {
  id: text('id').primaryKey(),
  plan: text('plan', { enum: ['free', 'pro'] })
    .notNull()
    .default('free'),
  segment: text('segment').notNull(),
  nickname: text('nickname'),
  credits: integer('credits').notNull().default(0),
  preferences: jsonb('preferences'),
  trialEndsAt: timestamp('trial_ends_at'),
  balance: bigint('balance', { mode: 'bigint' }),
});

describe('additionalFieldsFromColumns', () => {
  it('requires a NOT NULL column without a default, and only that', () => {
    const fields = additionalFieldsFromColumns(Users, ['segment', 'plan', 'nickname'], []);
    expect(fields['segment']?.required).toBe(true);
    expect(fields['plan']?.required).toBe(false);
    expect(fields['nickname']?.required).toBe(false);
  });

  it('maps column types: enum → its values, jsonb → json, timestamp → date, integer → number', () => {
    const fields = additionalFieldsFromColumns(Users, ['plan', 'preferences', 'trialEndsAt', 'credits'], []);
    expect(fields['plan']?.type).toEqual(['free', 'pro']);
    expect(fields['preferences']?.type).toBe('json');
    expect(fields['trialEndsAt']?.type).toBe('date');
    expect(fields['credits']?.type).toBe('number');
    expect(fields['plan']?.defaultValue).toBe('free');
  });

  it('lets the client set only the sign-up fields; every field is returned', () => {
    const fields = additionalFieldsFromColumns(Users, ['plan', 'segment'], ['segment']);
    expect(fields['segment']?.input).toBe(true);
    expect(fields['plan']?.input).toBe(false);
    expect(fields['plan']?.returned).toBe(true);
  });

  it('refuses a name that is not a column, and a type the engine cannot carry (E001)', () => {
    expect(() => additionalFieldsFromColumns(Users, ['nope'], [])).toThrow(
      expect.objectContaining({ code: AUTH_ERROR_CODES.invalidConfig }),
    );
    expect(() => additionalFieldsFromColumns(Users, ['balance'], [])).toThrow(
      expect.objectContaining({ code: AUTH_ERROR_CODES.invalidConfig }),
    );
  });
});
