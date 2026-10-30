/**
 * Provider answers are outside data. Why these tests matter: a service that sends a field of the
 * wrong type, or no JSON at all, must produce a typed failure, not a crash that loses the send result.
 */
import { describe, expect, it } from 'vitest';

import {
  cloudflareAnswerSchema,
  readAnswer,
  resendRefusalSchema,
  unosendRefusalSchema,
  unosendSentSchema,
} from './answers.js';

describe('readAnswer', () => {
  it('reads the fields that fit and drops the ones that do not', () => {
    expect(readAnswer(resendRefusalSchema, { message: 'bad', name: 42 })?.message).toBe('bad');
    expect(readAnswer(resendRefusalSchema, { message: 'bad', name: 42 })?.name).toBeUndefined();
  });

  it('is undefined when the answer is not an object', () => {
    expect(readAnswer(resendRefusalSchema, void 0)).toBeUndefined();
    expect(readAnswer(resendRefusalSchema, 'Bad Gateway')).toBeUndefined();
    expect(readAnswer(resendRefusalSchema, ['x'])).toBeUndefined();
  });

  it('reads Cloudflare answers whose lists hold the wrong thing as having no list', () => {
    const answer = readAnswer(cloudflareAnswerSchema, {
      success: true,
      errors: 'oops',
      result: { message_id: 'm1', delivered: ['a@b.dev', 7] },
    });
    expect(answer?.errors).toBeUndefined();
    expect(answer?.result).toMatchObject({ message_id: 'm1', delivered: undefined });
  });

  it('reads an Unosend id from the top level or from data', () => {
    expect(readAnswer(unosendSentSchema, { id: 'a' })?.id).toBe('a');
    expect(readAnswer(unosendSentSchema, { data: { id: 'b' } })?.data?.id).toBe('b');
  });

  it('reads an Unosend error given as plain text', () => {
    expect(readAnswer(unosendRefusalSchema, { error: 'nope' })?.error).toBe('nope');
  });
});
