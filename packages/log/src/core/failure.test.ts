import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { Value } from './types.js';
import { logfmt, pretty } from './formatters.js';
import { jsonValue } from './json.js';
import { createLogging } from './logging.js';
import { redact } from './processors.js';
import { MAX_CAUSE_LINKS, serializeFailure } from './serialize.js';
import { lineSink } from './sinks.js';

const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string(), email: z.string().optional() }),
  message: 'no post {id}',
  remediation: 'Check the id, or create the post first.',
});
const DbTimeout = defineFailure('db.timeout', { status: 503 });

/** Logs one record at info through a line sink and returns the line. */
function logLine(format: 'json' | 'pretty' | 'logfmt', fields: Readonly<Record<string, Value>>, paths?: string[]) {
  const out: string[] = [];
  const logging = createLogging();
  const formatter = format === 'json' ? undefined : format === 'pretty' ? pretty() : logfmt();
  logging.configure({
    channels: { out: lineSink(line => out.push(line), formatter ? { format: formatter } : {}) },
    default: { level: 'info', channels: ['out'] },
    processors: paths ? [redact(paths)] : [],
  });
  logging.getLogger('test').info('lookup', fields);
  return out[0] ?? '';
}

describe('a failure logged as a field', () => {
  it('prints code, message, status, data and remediation in json()', () => {
    // WHY: a failure is the expected outcome a log reader must act on. Its code and data are
    // what they search by, and the remediation says what to do.
    const line = JSON.parse(logLine('json', { failure: PostNotFound({ id: 'p1' }) }));
    expect(line.fields.failure).toEqual({
      code: 'post.not_found',
      message: 'no post p1',
      status: 404,
      data: { id: 'p1' },
      remediation: 'Check the id, or create the post first.',
    });
  });

  it('walks the cause chain through thrown errors and nested failures, nearest first', () => {
    // WHY: the root cause is usually two links down (a failure wrapping a driver error). A log
    // that stops at the top failure hides it.
    const socket = new Error('socket hang up');
    const driver = Object.assign(new Error('query failed', { cause: socket }), { code: 'ECONNRESET' });
    const timeout = DbTimeout({ cause: driver });
    const failure = PostNotFound({ id: 'p1' }, { cause: timeout });
    const fields = serializeFailure(failure);
    expect(fields.causes).toMatchObject([
      { code: 'db.timeout', message: 'db.timeout', status: 503 },
      { name: 'Error', message: 'query failed', code: 'ECONNRESET' },
      { name: 'Error', message: 'socket hang up' },
    ]);
    expect(JSON.parse(logLine('json', { failure })).fields.failure.causes).toHaveLength(3);
  });

  it('stops at a cycle and after the same number of links as findCause', () => {
    // WHY: a log call must never hang or blow the stack on a bad chain.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    expect(serializeFailure(DbTimeout({ cause: b })).causes).toEqual([
      expect.objectContaining({ message: 'b' }),
      expect.objectContaining({ message: 'a' }),
      '[Circular]',
    ]);

    let chain: unknown = new Error('root');
    for (let link = 0; link < MAX_CAUSE_LINKS + 10; link++) chain = DbTimeout({ cause: chain });
    const causes = serializeFailure(DbTimeout({ cause: chain })).causes;
    expect(causes).toHaveLength(MAX_CAUSE_LINKS + 1);
    expect(Array.isArray(causes) ? causes.at(-1) : undefined).toBe('[MaxDepth]');
    expect(MAX_CAUSE_LINKS).toBe(64);
  });

  it('keeps the brand out of the output', () => {
    expect(jsonValue(PostNotFound({ id: 'p1' }))).not.toContain('~failure');
  });

  it('prints its code in pretty() and logfmt()', () => {
    // WHY: dev consoles and logfmt pipelines need the code too, not `[object Object]`.
    for (const format of ['pretty', 'logfmt'] as const) {
      const line = logLine(format, { failure: PostNotFound({ id: 'p1' }, { cause: DbTimeout() }) });
      expect(line).toContain(String.raw`\"code\":\"post.not_found\"`);
      expect(line).toContain(String.raw`\"causes\":[{\"code\":\"db.timeout\"`);
    }
  });

  it('lets redact() reach the failure data and its causes', () => {
    // WHY: failure data can hold personal data (an email). Redaction must reach it like any field.
    const failure = PostNotFound({ id: 'p1', email: 'ada@example.com' }, { cause: DbTimeout() });
    const line = logLine('json', { failure }, ['failure.data.email', 'failure.causes.*.status']);
    expect(line).not.toContain('ada@example.com');
    expect(JSON.parse(line).fields.failure).toMatchObject({
      code: 'post.not_found',
      data: { id: 'p1', email: '[REDACTED]' },
      causes: [{ code: 'db.timeout', status: '[REDACTED]' }],
    });
  });

  it('is a field value by type', () => {
    expectTypeOf(PostNotFound({ id: 'p1' })).toExtend<Value>();
  });
});
