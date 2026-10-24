/**
 * The AI kit on the real local Ollama: real judge, real embedder, no fakes of our own code.
 * Needs `gemma4:latest` and `nomic-embed-text:latest` installed (the kit never pulls).
 */
import { describe, it } from 'vitest';

import { ollama } from '../services/ollama.js';
import { cosine, createEmbedder, createJudge } from './judge.js';
import { UnscorableError } from './matcher.js';
import { containsFacts, grounded, rubric, shape, similarTo } from './scorers.js';
import { expect } from './vitest.js';

const JUDGE = 'gemma4:latest';
const EMBEDDING = 'nomic-embed-text:latest';

const lisbon =
  'Lisbon City Council published a canopy study on 12 June 2023. On the hottest day, streets with 30 percent tree canopy were 4 degrees Celsius cooler at noon than streets with no canopy. The council plants 5000 trees each year.';

describe('ollama service', () => {
  it('reports the digest of the judge and the embedding model, and fails with the pull command for a missing one', async () => {
    const started = await ollama({ judge: JUDGE, embedding: EMBEDDING }).start({ runId: 'ai-test' });
    expect(started.value.judge).toBe(JUDGE);
    expect(started.value.embedding).toBe(EMBEDDING);
    expect(started.value.digests[JUDGE]).toMatch(/^[0-9a-f]{64}$/);
    expect(started.value.digests[EMBEDDING]).toMatch(/^[0-9a-f]{64}$/);
    await started.stop();

    await expect(ollama({ judge: 'no-such-model:1b' }).start({ runId: 'ai-test' })).rejects.toThrow(
      /OLLAMA_MODEL_MISSING.*ollama pull no-such-model:1b/,
    );
  });
});

describe('createJudge', { timeout: 180_000 }, () => {
  it('refuses a judge that is the model under test, by digest, unless told it is allowed', async () => {
    await expect(createJudge({ model: JUDGE, target: JUDGE })).rejects.toThrow(/JUDGE_IS_TARGET/);
    const judge = await createJudge({ model: JUDGE, target: JUDGE, allowSameModelAsJudge: true });
    expect(judge.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('code scorers', () => {
  it('shape passes a matching output and fails a wrong one with the issues', async () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) =>
          typeof value === 'object' && value !== null && 'title' in value
            ? { value }
            : { issues: [{ message: 'title is required' }] },
      },
    };
    await expect({ title: 'x' }).toScore(shape(schema));
    await expect(expect({ body: 'x' }).toScore(shape(schema))).rejects.toThrow(/title is required/);
  });

  it('containsFacts scores the share found, ignoring case, punctuation and the commas in numbers', async () => {
    const scorer = containsFacts(['4 degrees', 'council', '5,000', 'Nature Cities']);
    const score = await scorer.score({ output: lisbon, input: undefined, expected: undefined }, {});
    expect(score).toMatchObject({ status: 'scored', value: 0.75, pass: false });
    await expect(lisbon).toScore(containsFacts(['12 June 2023', '5000 trees']));
  });
});

describe('toScore', { timeout: 180_000 }, () => {
  it('an unscorable result throws, even under .not: missing evidence is never a pass', async () => {
    const judge = await createJudge({ model: JUDGE });
    await expect(expect('').toScore(containsFacts([]))).rejects.toThrow(UnscorableError);
    await expect(expect('').not.toScore(containsFacts([]))).rejects.toThrow(UnscorableError);
    expect(judge.model).toBe(JUDGE);
  });

  it('a judge scorer without a judge says so', async () => {
    await expect(expect('x').toScore(rubric('is polite'))).rejects.toThrow(/JUDGE_REQUIRED/);
  });
});

describe('judge scorers on the real model', { timeout: 180_000 }, () => {
  it('grounded passes a faithful summary and fails one with a wrong number, and says which claim', async () => {
    const judge = await createJudge({ model: JUDGE });
    await expect('Streets with 30 percent canopy were 4 degrees cooler at noon.').toScore(
      grounded({ source: lisbon }),
      { judge },
    );

    const wrong = 'Streets with 30 percent canopy were 8 degrees cooler at noon.';
    const match = await grounded({ source: lisbon }).score(
      { output: wrong, input: undefined, expected: undefined },
      { judge },
    );
    expect(match).toMatchObject({ status: 'scored', pass: false });
    expect(match.reason).toContain('8 degrees');
    await expect(expect(wrong).toScore(grounded({ source: lisbon }), { judge })).rejects.toThrow(/8 degrees/);
  });

  it('grounded gives the same score twice (seeded) and is unscorable on an output with no claims', async () => {
    const judge = await createJudge({ model: JUDGE });
    const scorer = grounded({ source: lisbon });
    const sample = { output: 'The council plants 5000 trees each year.', input: undefined, expected: undefined };
    expect(await scorer.score(sample, { judge })).toEqual(await scorer.score(sample, { judge }));
    const none = await scorer.score({ ...sample, output: 'Hello!' }, { judge });
    expect(none.status).toBe('unscorable');
  });

  it('rubric returns a verdict with the critique as its reason', async () => {
    const judge = await createJudge({ model: JUDGE });
    await expect('Shade from tree crowns cools a street.').toScore(rubric('The text is about trees or shade.'), {
      judge,
    });
    await expect(
      expect('Posten delivers letters every second weekday.').toScore(rubric('The text is about trees or shade.'), {
        judge,
      }),
    ).rejects.toThrow(/rubric scored 0\.00/);
  });
});

describe('similarTo', { timeout: 180_000 }, () => {
  it('separates a paraphrase from an unrelated text, and is documented as gist only', async () => {
    const embedder = await createEmbedder({ model: EMBEDDING });
    const anchor = 'Streets with 30 percent tree canopy were 4 degrees cooler at noon.';
    const [a, paraphrase, unrelated] = await embedder.embed([
      anchor,
      'At midday, streets whose canopy covered 30% were cooler by four degrees.',
      'Posten cut Saturday letter delivery in 2016.',
    ]);
    if (a === undefined || paraphrase === undefined || unrelated === undefined)
      throw new Error('embedder returned too few vectors');
    const close = cosine(a, paraphrase);
    const far = cosine(a, unrelated);
    expect(close).toBeGreaterThan(far + 0.15);
    const bar = (close + far) / 2;
    await expect('At midday, streets whose canopy covered 30% were cooler by four degrees.').toScore(
      similarTo(anchor, { atLeast: bar }),
      { embedder },
    );
    await expect(
      expect('Posten cut Saturday letter delivery in 2016.').toScore(similarTo(anchor, { atLeast: bar }), { embedder }),
    ).rejects.toThrow(/cosine similarity/);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
  });
});
