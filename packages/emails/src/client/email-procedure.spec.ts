import type { StandardSchemaV1 } from '@arki/schema';
import { SchemaRunError } from '@arki/schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { EmailProvider, SendEmailPayload } from '../providers/types';
import { initEmails } from './init';

vi.mock('../debug', () => ({ debugEmails: { debug: vi.fn() } }));

/** A provider that records what it was asked to send. */
function recordingProvider() {
  const sent: SendEmailPayload[] = [];
  const provider: EmailProvider = {
    name: 'recording',
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ data: { id: `id-${sent.length}` }, error: null });
    },
  };
  return { sent, emails: initEmails({ providers: [provider] }) };
}

/** No library: takes a string, hands the resolvers its length. Output type differs from input type. */
const lengthOf: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand-written',
    validate: value =>
      typeof value === 'string' ? { value: value.length } : { issues: [{ message: 'expected a string' }] },
  },
};

describe('EmailProcedure.input accepts any Standard Schema', () => {
  it('hand-written schema: send takes the input type, resolvers get the output', async () => {
    const { sent, emails } = recordingProvider();
    const welcome = emails.email
      .input(lengthOf)
      .from('a@example.com')
      .subject(length => {
        expectTypeOf(length).toEqualTypeOf<number>();
        return `name has ${length} letters`;
      });
    expectTypeOf<Parameters<typeof welcome.send>[0]['input']>().toEqualTypeOf<string>();

    await welcome.send({ to: 'b@example.com', input: 'Ada' });

    // The resolver must see the PARSED value, or transforms would be silently ignored.
    expect(sent[0]?.subject).toBe('name has 3 letters');
  });

  it('zod: transforms reach the resolvers', async () => {
    const { sent, emails } = recordingProvider();
    const receipt = emails.email
      .input(z.object({ total: z.string().transform(Number) }))
      .subject(({ total }) => {
        expectTypeOf(total).toEqualTypeOf<number>();
        return `Total: ${(total * 2).toString()}`;
      });
    expectTypeOf<Parameters<typeof receipt.send>[0]['input']>().toEqualTypeOf<{ total: string }>();

    await receipt.send({ to: 'b@example.com', input: { total: '21' } });

    expect(sent[0]?.subject).toBe('Total: 42');
  });

  it('valibot: nested `{ key }` path segments show up in the error message', async () => {
    const { sent, emails } = recordingProvider();
    const invite = emails.email
      .input(v.object({ user: v.object({ email: v.pipe(v.string(), v.email('bad email')) }) }))
      .subject(({ user }) => `Invite for ${user.email}`);

    const result = await invite.send({ to: 'b@example.com', input: { user: { email: 'nope' } } });

    // Callers read the path to tell the user which field is wrong.
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ name: 'ValidationError', message: 'user.email: bad email' });
    // The issue arrives untouched: Valibot's `{ key }` segments are not flattened away.
    expect(result.error?.issues?.[0]?.path).toEqual([
      expect.objectContaining({ key: 'user' }),
      expect.objectContaining({ key: 'email' }),
    ]);
    expect(sent).toHaveLength(0);
  });

  it('arktype: valid input is sent', async () => {
    const { sent, emails } = recordingProvider();
    const hello = emails.email.input(type({ name: 'string' })).text(({ name }) => `Hello ${name}`);

    const result = await hello.send({ to: 'b@example.com', input: { name: 'Ada' } });

    expect(result.error).toBeNull();
    expect(sent[0]?.text).toBe('Hello Ada');
  });

  it('async schema: send awaits async checks instead of failing', async () => {
    const { sent, emails } = recordingProvider();
    const notice = emails.email
      .input(z.object({ code: z.string().refine(code => Promise.resolve(code === 'ok'), 'code rejected') }))
      .text(({ code }) => code);

    const bad = await notice.send({ to: 'b@example.com', input: { code: 'no' } });
    await notice.send({ to: 'b@example.com', input: { code: 'ok' } });

    expect(bad.error).toMatchObject({ name: 'ValidationError', message: 'code: code rejected' });
    expect(sent.map(payload => payload.text)).toEqual(['ok']);
  });
});

describe('EmailProcedure error contract', () => {
  it('a schema that throws is a bug, not bad input: send rejects with SchemaRunError', async () => {
    const { emails } = recordingProvider();
    const broken: StandardSchemaV1<string, string> = {
      '~standard': {
        version: 1,
        vendor: 'broken',
        validate: () => {
          throw new Error('boom');
        },
      },
    };

    await expect(emails.email.input(broken).send({ to: 'b@example.com', input: 'x' })).rejects.toBeInstanceOf(
      SchemaRunError,
    );
  });

  it('every issue reaches the caller with its exact path, which the message alone cannot carry', async () => {
    const { emails } = recordingProvider();
    const issues: StandardSchemaV1.Issue[] = [
      { message: 'flat key', path: ['a.b'] },
      { message: 'nested key', path: ['a', 'b'] },
    ];
    const twoIssues: StandardSchemaV1<string, string> = {
      '~standard': { version: 1, vendor: 'hand-written', validate: () => ({ issues }) },
    };

    const result = await emails.email.input(twoIssues).send({ to: 'b@example.com', input: 'x' });

    // Both print as "a.b", so only `issues` tells a key named "a.b" from key "b" inside "a".
    expect(result.error?.message).toBe('a.b: flat key; a.b: nested key');
    expect(result.error?.issues).toEqual(issues);
  });

  it('input() only exists before the setters, so a resolver typed for no input never gets one', () => {
    const { emails } = recordingProvider();

    // @ts-expect-error -- .input() must come before .from/.subject/.text/.html/.react
    expect(() => emails.email.subject('Hi').input(lengthOf)).toThrow(TypeError);
  });

  it('without a schema, send takes no input and the resolvers get nothing', async () => {
    const { sent, emails } = recordingProvider();
    const ping = emails.email.subject(input => {
      expectTypeOf(input).toEqualTypeOf<void>();
      return 'ping';
    });

    await ping.send({ to: 'b@example.com' });

    expect(sent[0]?.subject).toBe('ping');
  });
});
