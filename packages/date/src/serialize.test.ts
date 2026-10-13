import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { StandardRPCJsonSerializer } from '@orpc/client/standard';
import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import SuperJSON from 'superjson';
import { describe, expect, it } from 'vitest';

import { instant, plainDate, plainDateTime, zoned } from './core.js';
import { registerTemporalTypes, temporalJsonSerializers } from './serialize.js';
import { Temporal } from './types.js';

const sample = {
  at: instant('2026-03-29T00:30:00.123456789Z'),
  local: zoned('2026-03-29T04:30:00+03:00[Europe/Bucharest]'),
  day: plainDate('2026-02-28'),
  wall: plainDateTime('2026-05-20T09:30'),
  length: Temporal.Duration.from('P1DT2H30M'),
  nested: [{ seenAt: instant('2026-01-01T00:00:00Z') }],
  untouched: new Date('2026-01-01T00:00:00Z'),
};

function expectSameValues(actual: unknown): void {
  expect(actual).toEqual(sample);
  // `toEqual` sees Temporal objects as empty; compare their text, which carries every field.
  expect(JSON.stringify(actual)).toBe(JSON.stringify(sample));
}

describe('temporalJsonSerializers (oRPC)', () => {
  it('round-trips every Temporal type through the RPC JSON serializer', () => {
    const serializer = new StandardRPCJsonSerializer({ customJsonSerializers: temporalJsonSerializers });
    const [json, meta] = serializer.serialize(sample);
    expectSameValues(serializer.deserialize(json, meta));
  });

  it('carries values from a real handler to a real link', async () => {
    const router = { stamp: os.handler(() => sample) };
    const handler = new RPCHandler(router, { customJsonSerializers: temporalJsonSerializers });
    const link = new RPCLink({
      url: 'http://rpc.test',
      customJsonSerializers: temporalJsonSerializers,
      fetch: async request => {
        const { matched, response } = await handler.handle(request);
        if (!matched) throw new Error(`no procedure for ${request.url}`);
        return response;
      },
    });
    const client = createORPCClient<{ stamp: () => Promise<typeof sample> }>(link);
    const received = await client.stamp();
    expectSameValues(received);
    expect(received.local.timeZoneId).toBe('Europe/Bucharest');
    expect(received.at.epochNanoseconds).toBe(sample.at.epochNanoseconds);
  });

  it('rejects wire values that are not text', () => {
    const serializer = new StandardRPCJsonSerializer({ customJsonSerializers: temporalJsonSerializers });
    expect(() => serializer.deserialize({ at: 42 }, [[100, 'at']])).toThrow(/expected ISO text/);
  });
});

describe('registerTemporalTypes (SuperJSON)', () => {
  it('round-trips every Temporal type', () => {
    const superjson = new SuperJSON();
    registerTemporalTypes(superjson);
    expectSameValues(superjson.parse(superjson.stringify(sample)));
  });

  it('works on the default export and survives registering twice', () => {
    registerTemporalTypes(SuperJSON);
    registerTemporalTypes(SuperJSON);
    expectSameValues(SuperJSON.deserialize(SuperJSON.serialize(sample)));
  });
});
