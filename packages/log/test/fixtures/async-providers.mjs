import assert from 'node:assert/strict';
import process from 'node:process';

import { createLogging } from '../../src/core/logging.js';
import { consoleSink, memorySink } from '../../src/core/sinks.js';
import { otelSink } from '../../src/otel/index.js';

// JavaScript providers can return promises despite the synchronous TS contract.
// Observe every discarded provider promise without changing business outcomes.
const logging = createLogging();
const sink = memorySink();
const businessError = new Error('business');
const fault = new Error('observer');
console.error = async () => {
  throw fault;
};
console.info = async () => {
  throw fault;
};
const exporter = otelSink({
  getLogger: () => ({
    emit: async () => {
      throw fault;
    },
  }),
});
logging.configure({
  channels: { sink, console: consoleSink(), formatted: consoleSink({ format: () => 'formatted' }), exporter },
  default: { level: 'info', channels: ['sink', 'console', 'formatted', 'exporter'] },
  context: {
    get: async () => {
      throw fault;
    },
    run: async (_fields, callback) => {
      callback();
      throw fault;
    },
  },
  trace: async () => {
    throw fault;
  },
});
logging.getLogger().info('committed');
let calls = 0;
const businessPromise = Promise.reject(businessError);
const returned = logging.withContext({}, () => {
  calls++;
  return businessPromise;
});
assert.equal(returned, businessPromise);
await assert.rejects(returned, error => error === businessError);
assert.equal(calls, 1);
assert.equal(sink.records.length, 1);
await new Promise(resolve => setImmediate(resolve));

let thenCalls = 0;
let thenGetterCalls = 0;
const metadata = {
  then: () => {
    thenCalls++;
  },
};
const metadataLogging = createLogging();
metadataLogging.configure({
  channels: { sink },
  default: { level: 'info', channels: ['sink'] },
  context: { get: () => metadata, run: (_fields, callback) => callback() },
  trace: () =>
    Object.defineProperty({ traceId: 'trace', spanId: 'span' }, 'then', {
      get: () => {
        thenGetterCalls++;
        throw new Error('protocol is metadata');
      },
    }),
});
metadataLogging.getLogger().info('metadata remains data');
assert.equal(
  metadataLogging.withContext({}, () => 42),
  42,
);
await new Promise(resolve => setImmediate(resolve));
assert.equal(thenCalls, 0);
assert.equal(thenGetterCalls, 0);
process.stdout.write('async observation faults contained\n');
