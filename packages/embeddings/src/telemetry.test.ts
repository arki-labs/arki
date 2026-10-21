import { describe, expect, it } from 'vitest';

import { fakeLog } from '@arki/log/testing';

import { withCache } from './cache.js';
import { RateLimited } from './failures.js';
import { withTelemetry } from './telemetry.js';
import { fakeEmbedder } from './testing/index.js';

describe('withTelemetry', () => {
  it('inputs are not recorded by default: embed inputs carry emails and tokens', async () => {
    using log = fakeLog();
    const embedder = withTelemetry(fakeEmbedder({ dimensions: 8 }));

    await embedder.embed(['ana@example.com', 'sk-secret-token'], { purpose: 'document' });

    const event = log.records.find(record => record.eventName === 'arki.embed');
    expect(event?.fields).toMatchObject({ provider: 'fake', model: 'fake-8', dimensions: 8, inputs: 2, outcome: 'ok' });
    expect(JSON.stringify(log.records.map(record => record.fields))).not.toContain('ana@example.com');
    expect(JSON.stringify(log.records.map(record => record.fields))).not.toContain('sk-secret-token');
  });

  it('records inputs only when asked', async () => {
    using log = fakeLog();
    await withTelemetry(fakeEmbedder({ dimensions: 8 }), { recordInputs: true }).embed(['hello'], {});

    log.assertLogged({ eventName: 'arki.embed', fields: { texts: ['hello'] } });
  });

  it('one event per call, with the failure code as the outcome', async () => {
    using log = fakeLog();
    const embedder = withTelemetry(fakeEmbedder({ dimensions: 8, failures: { busy: RateLimited({}) } }));

    await embedder.embed(['busy'], {});

    const events = log.records.filter(record => record.eventName === 'arki.embed');
    expect(events).toHaveLength(1);
    expect(events[0]?.fields).toMatchObject({ outcome: 'embeddings.rate_limited', inputs: 1, requests: 0 });
  });

  it('outside withCache it counts cache hits and token basis', async () => {
    using log = fakeLog();
    const embedder = withTelemetry(withCache(fakeEmbedder({ dimensions: 8 })));

    await embedder.embed(['a'], {});
    await embedder.embed(['a'], {});

    const events = log.records.filter(record => record.eventName === 'arki.embed');
    expect(events.map(event => event.fields['cacheHits'])).toEqual([0, 1]);
    expect(events[0]?.fields).toMatchObject({ tokenBasis: 'estimated', requests: 1 });
  });
});
