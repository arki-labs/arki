import { SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';

import { captureSpans } from '@arki/testing/otel';

import { initializeStorage } from './s3.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('builds the S3 client when called, not when the module loads', () => {
  expect(typeof initializeStorage).toBe('function');
  expect(initializeStorage('bucket', 'prefix', 'eu-west-1')).toBeDefined();
});

it('builds the handle inside an fs.s3.initialize_storage span under the caller, with no bucket, prefix or key', () => {
  // WHY: the legacy bridge was the one fs entry with no span (fs F2). An operator must see it under
  // the operation that built it, and the bucket, prefix, region and credentials must stay off the span.
  using spans = captureSpans();
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA_SECRET_SENTINEL');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-sentinel');

  trace.getTracer('app').startActiveSpan('job', job => {
    expect(initializeStorage('private-bucket', 'private-prefix', 'eu-west-1')).toBeDefined();
    job.end();
  });

  const span = spans.named('fs.s3.initialize_storage');
  expect(span.parent?.name).toBe('job');
  expect(span.status.code).toBe(SpanStatusCode.UNSET);
  expect(span.attributes).toEqual({});
});
