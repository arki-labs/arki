import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embed, embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { Cancelled, InvalidOutput, RateLimited } from '../failures.js';
import { cosine, norm } from '../vector.js';
import { echoTexts, stubModel } from '../tests/stub-model.js';
import { fakeEmbedder, fixtureEmbedder, recordEmbedder } from './index.js';

describe('./testing fakeEmbedder', () => {
  // Tests compare vectors by equality; the fake must be reproducible on every run and runtime.
  it('same text and seed give the same unit vector', async () => {
    const first = await embed(fakeEmbedder({ dimensions: 64, seed: 7 }), 'a');
    const second = await embed(fakeEmbedder({ dimensions: 64, seed: 7 }), 'a');
    if (isFailure(first) || isFailure(second)) throw new Error('fake failed');
    expect([...first.vector]).toEqual([...second.vector]);
    expect(norm(first.vector)).toBeCloseTo(1, 6);
    expect(first.vector).toBeInstanceOf(Float32Array);
    if (first.vector instanceof Float32Array && second.vector instanceof Float32Array) {
      expect(cosine(first.vector, second.vector)).toBe(1);
    }
  });

  it('different seeds differ', async () => {
    const one = await embed(fakeEmbedder({ dimensions: 64, seed: 1 }), 'a');
    const two = await embed(fakeEmbedder({ dimensions: 64, seed: 2 }), 'a');
    if (isFailure(one) || isFailure(two)) throw new Error('fake failed');
    expect([...one.vector]).not.toEqual([...two.vector]);
    expect(one.space.revision).not.toBe(two.space.revision);
  });

  // All-or-nothing must be visible in tests: one bad input fails the whole call.
  it('a configured failure fails the whole batch', async () => {
    const fake = fakeEmbedder({ dimensions: 8, failures: { boom: RateLimited({ retryAfterMs: 100 }) } });
    const result = await embedMany(fake, ['fine', 'boom', 'also fine']);
    expect(isFailure(result) && result.code).toBe('embeddings.rate_limited');
    expect(isFailure(result) && result.data).toEqual({ retryAfterMs: 100 });
  });
});

/** A recording file as `fixtureEmbedder` receives it: parsed, unchecked JSON. */
const load = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

describe('recordEmbedder and fixtureEmbedder', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arki-embeddings-fixtures-'));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // A test that replays a real model must get the exact vectors, space and chunking it recorded,
  // or it checks a different corpus than production embeds.
  it('fixtures round-trip', async () => {
    const file = path.join(directory, 'float.json');
    const live = fakeEmbedder({ dimensions: 8, seed: 3 });
    const texts = ['the rain in Spain', 'ploaia din Spania', 'a third text'];
    const recorded = await embedMany(recordEmbedder(live, file), texts, { purpose: 'document' });
    if (isFailure(recorded)) throw new Error(recorded.message);

    const replay = fixtureEmbedder(load(file));
    if (isFailure(replay)) throw new Error(replay.message);
    const replayed = await embedMany(replay, texts, { purpose: 'document' });
    if (isFailure(replayed)) throw new Error(replayed.message);
    expect(replayed.vectors).toEqual(recorded.vectors);
    expect(replayed.space).toEqual(recorded.space);
    expect(replay.space).toEqual(live.space);
  });

  // A miss must fail loudly: a made-up vector would let a test pass against data nobody recorded.
  it('a request that was not recorded is InvalidOutput', async () => {
    const file = path.join(directory, 'miss.json');
    await embed(recordEmbedder(fakeEmbedder({ dimensions: 8 }), file), 'recorded', { purpose: 'query' });
    const replay = fixtureEmbedder(load(file));
    if (isFailure(replay)) throw new Error(replay.message);
    const otherText = await embed(replay, 'never recorded', { purpose: 'query' });
    const otherPurpose = await embed(replay, 'recorded', { purpose: 'document' });
    expect(InvalidOutput.is(otherText) && otherText.data.reason).toMatch(/no fixture/);
    expect(InvalidOutput.is(otherPurpose) && otherPurpose.data.reason).toMatch(/no fixture/);
  });

  it('binary vectors replay as the same packed bytes', async () => {
    const file = path.join(directory, 'binary.json');
    const embedder = createEmbedder(
      stubModel(request => echoTexts({ ...request, dimensions: 8 }), { dimensions: 8, matryoshka: [] }),
      { quantization: 'binary' },
    );
    if (isFailure(embedder)) throw new Error(embedder.message);
    const recorded = await embed(recordEmbedder(embedder, file), 't1');
    const replay = fixtureEmbedder(load(file));
    if (isFailure(replay) || isFailure(recorded)) throw new Error('refused');
    const replayed = await embed(replay, 't1');
    if (isFailure(replayed)) throw new Error(replayed.message);
    expect(replayed.vector).toBeInstanceOf(Uint8Array);
    expect(replayed.vector).toEqual(recorded.vector);
  });

  // `withCache` keys a call by the replay's space; a size taken from whichever call came first would
  // file full-size vectors under a smaller space.
  it("replay's own space is the embedder's, whatever size the first call asked for", async () => {
    const file = path.join(directory, 'sizes.json');
    const live = createEmbedder(stubModel(echoTexts, { dimensions: 4, matryoshka: [4, 2] }));
    if (isFailure(live)) throw new Error(live.message);
    const recorder = recordEmbedder(live, file);
    await embed(recorder, 't1', { dimensions: 2 });
    await embed(recorder, 't2');
    const replay = fixtureEmbedder(load(file));
    if (isFailure(replay)) throw new Error(replay.message);
    expect(replay.space.dimensions).toBe(4);
    expect(replay.spaceFor({}).dimensions).toBe(4);
    expect(replay.spaceFor({ dimensions: 2 }).dimensions).toBe(2);
  });

  // An embedder never throws; a recording path that cannot be written is the caller's setup.
  it('an unwritable path is ConfigurationFailure, not a throw', async () => {
    const recorder = recordEmbedder(fakeEmbedder({ dimensions: 8 }), path.join(directory, 'missing', 'dir', 'x.json'));
    const result = await embed(recorder, 'text');
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
    // The next call writes again rather than inheriting the failed write.
    const ok = await embed(recordEmbedder(fakeEmbedder({ dimensions: 8 }), path.join(directory, 'ok.json')), 'text');
    expect(isFailure(ok)).toBe(false);
  });

  // Replay must cancel like a live embedder, or a cancellation test passes only offline.
  it('replay honours an aborted signal', async () => {
    const file = path.join(directory, 'abort.json');
    await embed(recordEmbedder(fakeEmbedder({ dimensions: 8 }), file), 'text');
    const replay = fixtureEmbedder(load(file));
    if (isFailure(replay)) throw new Error(replay.message);
    const controller = new AbortController();
    controller.abort();
    expect(Cancelled.is(await embed(replay, 'text', { signal: controller.signal }))).toBe(true);
  });

  it('a file that is not a recording is ConfigurationFailure', () => {
    for (const bad of [[], {}, [{ key: 'k' }]]) {
      const refused = fixtureEmbedder(bad);
      expect(isFailure(refused) && refused.code).toBe('embeddings.configuration');
    }
  });
});
