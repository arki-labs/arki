import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DecryptionFailed, EncryptionFailed } from './errors.js';
import { nodeOperation } from './operation-telemetry.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('owned node-operation telemetry', () => {
  it('uses the API span, records only bounded outcome data, and ends on a returned failure', () => {
    // WHY: a 4xx (a wrong key, 422) is an expected outcome: its code is recorded, the status stays unset.
    const span = trace.wrapSpanContext({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 });
    const ended = vi.spyOn(span, 'end');
    const status = vi.spyOn(span, 'setStatus');
    const attribute = vi.spyOn(span, 'setAttribute');
    const attributes = vi.spyOn(span, 'setAttributes');
    const tracer = trace.getTracer('env-test');
    const start = vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
    vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const failure = DecryptionFailed({ cause: new Error('SYNTHETIC_SECRET_VALUE') });
    expect(nodeOperation('load', () => failure)).toBe(failure);
    expect(start).toHaveBeenCalledWith('env.load');
    expect(attribute).toHaveBeenCalledWith('failure.code', DecryptionFailed.code);
    expect(status).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(attributes).not.toHaveBeenCalled();
  });
  it('marks the span as an error for a returned fault (5xx)', () => {
    // WHY: a 5xx means the tool or machine is broken; error status is what alerts read.
    const span = trace.wrapSpanContext({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 });
    const status = vi.spyOn(span, 'setStatus');
    const attribute = vi.spyOn(span, 'setAttribute');
    const tracer = trace.getTracer('env-test');
    vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
    vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const failure = EncryptionFailed({ cause: new Error('SYNTHETIC_SECRET_VALUE') });
    expect(nodeOperation('init', () => failure)).toBe(failure);
    expect(attribute).toHaveBeenCalledWith('failure.code', EncryptionFailed.code);
    expect(status).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });
  it('does not let broken tracing, metrics or context change the value or execute work twice', () => {
    vi.spyOn(context, 'with').mockImplementation(() => {
      throw new Error('bad context manager');
    });
    vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
      throw new Error('bad meter');
    });
    let calls = 0;
    const marker = {};
    expect(
      nodeOperation('load', () => {
        calls++;
        return marker;
      }),
    ).toBe(marker);
    expect(calls).toBe(1);
    vi.spyOn(trace, 'getTracer').mockImplementation(() => {
      throw new Error('bad tracer');
    });
    const bug = new Error('caller defect');
    expect(() =>
      nodeOperation('load', () => {
        calls++;
        throw bug;
      }),
    ).toThrow(bug);
    expect(calls).toBe(2);
  });
});
