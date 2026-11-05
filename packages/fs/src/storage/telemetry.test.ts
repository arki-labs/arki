import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { context, metrics, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SpanCapture } from '@arki/testing/otel';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { deleteSync } from '../local/delete.js';
import { globIterate } from '../local/glob.js';
import { StorageRejected } from './failures.js';
import { createLocalStorageAdapter } from './local-adapter.js';
import { observeFs } from './operation.js';

let spans: SpanCapture;
const directories: string[] = [];
beforeEach(() => {
  spans = captureSpans();
});
afterEach(async () => {
  vi.restoreAllMocks();
  spans[Symbol.dispose]();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('emits a meaningful standalone span and retains an application parent without private attributes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-arki-fs-'));
  directories.push(directory);
  const storage = createLocalStorageAdapter({
    provider: 'local',
    basePath: directory,
    baseUrl: 'https://secret.audit.invalid',
  });
  const parent = trace.getTracer('application').startSpan('application.operation');
  const result = await context.with(trace.setSpan(context.active(), parent), () =>
    storage.put('private-key', Buffer.from('private-bytes')),
  );
  orThrow(result);
  parent.end();
  expect(spans.named('fs.local.put').parent?.spanContext().spanId).toBe(parent.spanContext().spanId);
  const encoded = JSON.stringify(
    spans.finished.map(span => ({ name: span.name, attributes: span.attributes, events: span.events })),
  );
  expect(encoded).not.toMatch(/private-|secret\.audit/);
});

it('reports default bounded metrics and failure.code without exporting a cause', async () => {
  const meter = metrics.getMeter('@arki/fs');
  const counter = meter.createCounter('owned');
  const duration = meter.createHistogram('owned');
  const add = vi.spyOn(counter, 'add');
  const record = vi.spyOn(duration, 'record');
  vi.spyOn(metrics, 'getMeter').mockReturnValue(meter);
  vi.spyOn(meter, 'createCounter').mockReturnValue(counter);
  vi.spyOn(meter, 'createHistogram').mockReturnValue(duration);
  const failure = StorageRejected({ cause: new Error('private cause') });
  expect(await observeFs('fs.local.get', () => failure)).toBe(failure);
  expect(add).toHaveBeenCalledWith(1, { operation: 'fs.local.get', 'failure.code': failure.code });
  expect(record).toHaveBeenCalledWith(expect.any(Number), { operation: 'fs.local.get', 'failure.code': failure.code });
  expect(spans.finished[0]?.attributes).toEqual({ 'failure.code': failure.code });
});

it.each(['omit', 'repeat', 'throw-before', 'throw-after', 'reject'] as const)(
  'executes once and preserves failure identity when a context manager misbehaves: %s',
  async mode => {
    const failure = StorageRejected();
    let executions = 0;
    vi.spyOn(context, 'with').mockImplementation((_context, callback) => {
      if (mode === 'throw-before') throw new Error('reporter fault');
      if (mode === 'omit') return;
      const result = callback();
      if (mode === 'repeat') callback();
      if (mode === 'throw-after') throw new Error('reporter fault');
      if (mode === 'reject') return Promise.reject(new Error('asynchronous reporter fault'));
      return result;
    });
    expect(
      await observeFs('fs.local.get', () => {
        executions++;
        return failure;
      }),
    ).toBe(failure);
    await Promise.resolve();
    expect(executions).toBe(1);
  },
);

it('isolates throwing metric providers and rejected end reports', async () => {
  const tracer = trace.getTracer('@arki/fs');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    const span = start(...args);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Deliberately defective void reporter.
    vi.spyOn(span, 'end').mockImplementation(() => Promise.reject(new Error('broken reporter')));
    return span;
  });
  vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
    throw new Error('broken meter');
  });
  const failure = StorageRejected();
  expect(await observeFs('fs.local.get', () => failure)).toBe(failure);
  await Promise.resolve();
});

it('the sync and iterating local helpers record the same span and failure code as their siblings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arki-fs-telemetry-'));
  directories.push(directory);
  const outside = path.join(directory, 'outside');
  await writeFile(outside, 'kept');
  expect(StorageRejected.is(deleteSync(outside))).toBe(true);
  const walk = globIterate('*', { cwd: directory, signal: AbortSignal.abort() });
  for (let next = await walk.next(); !next.done; next = await walk.next()) expect(next.value).toBeUndefined();
  const recorded = spans.finished.map(span => ({ name: span.name, code: span.attributes['failure.code'] }));
  expect(recorded).toEqual([
    { name: 'fs.local.delete_paths', code: 'fs.storage_rejected' },
    { name: 'fs.local.glob', code: 'fs.storage_cancelled' },
  ]);
});
