/**
 * Templates are typed by one Standard Schema. Why it matters: a mail sent with the wrong data
 * goes to a real person and cannot be taken back, so wrong data must not compile, and data the
 * schema refuses must come back as a result before anything is sent.
 */
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { SchemaRunError } from '@arki/schema';

import { MAIL_ERROR_CODES } from './errors.js';
import { defineTemplate, renderTemplate } from './template.js';

const welcome = defineTemplate({
  name: 'welcome',
  input: z.object({ name: z.string(), trialDays: z.number().default(14) }),
  subject: data => `Welcome, ${data.name}`,
  text: data => `Your trial lasts ${data.trialDays} days.`,
  html: data => `<p>Your trial lasts <b>${data.trialDays}</b> days.</p>`,
});

describe('types flow from the schema', () => {
  it('callers pass the schema input; renderers get its output with defaults applied', async () => {
    expectTypeOf(welcome.name).toEqualTypeOf<'welcome'>();
    // @ts-expect-error -- `name` is required
    await renderTemplate(welcome, { trialDays: 3 });
    // @ts-expect-error -- `trialDays` must be a number
    await renderTemplate(welcome, { name: 'Ada', trialDays: '3' });

    const rendered = await renderTemplate(welcome, { name: 'Ada' });
    expect(rendered.data).toEqual({
      subject: 'Welcome, Ada',
      text: 'Your trial lasts 14 days.',
      html: '<p>Your trial lasts <b>14</b> days.</p>',
    });
  });
});

describe('any Standard Schema drives a template', () => {
  const handwritten: StandardSchemaV1<{ code: string }, { code: string }> = {
    '~standard': {
      version: 1,
      vendor: 'handwritten',
      validate: value =>
        typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
          ? { value: { code: value.code } }
          : { issues: [{ message: 'code is required' }] },
    },
  };
  const schemas = {
    handwritten,
    zod: z.object({ code: z.string() }),
    valibot: v.object({ code: v.string() }),
    arktype: type({ code: 'string' }),
  };

  for (const [vendor, schema] of Object.entries(schemas)) {
    it(`${vendor}: renders good input and returns E003 for bad input`, async () => {
      const signIn = defineTemplate({
        name: 'sign-in-code',
        input: schema,
        subject: () => 'Your code',
        text: data => `Code: ${data.code}`,
      });
      await expect(renderTemplate(signIn, { code: '123456' })).resolves.toMatchObject({
        data: { text: 'Code: 123456' },
      });
      // @ts-expect-error -- a number where the schema wants a string: refused at compile time and at run time
      const bad = await renderTemplate(signIn, { code: 7 });
      expect(bad.error).toMatchObject({ code: MAIL_ERROR_CODES.invalidInput, retryable: false });
      expect(bad.error?.issues?.length).toBeGreaterThan(0);
    });
  }
});

describe('validation', () => {
  it('awaits async schemas and keeps the issue path', async () => {
    const asyncSchema = z
      .object({ user: z.object({ email: z.email() }) })
      .refine(value => Promise.resolve(value.user.email !== ''));
    const verify = defineTemplate({
      name: 'verify',
      input: asyncSchema,
      subject: () => 'Verify',
      text: data => data.user.email,
    });
    const result = await renderTemplate(verify, { user: { email: 'not-an-email' } });
    expect(result.error?.code).toBe(MAIL_ERROR_CODES.invalidInput);
    expect(result.error?.issues?.[0]?.path).toEqual(['user', 'email']);
  });

  it('a schema that throws is a bug and is thrown, not returned as bad input', async () => {
    const broken: StandardSchemaV1<{ id: string }> = {
      '~standard': {
        version: 1,
        vendor: 'broken',
        validate: () => {
          throw new Error('validator crashed');
        },
      },
    };
    const template = defineTemplate({ name: 'broken', input: broken, subject: () => 's', text: () => 't' });
    await expect(renderTemplate(template, { id: 'x' })).rejects.toBeInstanceOf(SchemaRunError);
  });
});
