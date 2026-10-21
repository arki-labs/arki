import { describe, expect, it } from 'vitest';

import { draftStory } from './draft-story.js';

describe('draftStory', () => {
  it('feeds the outline of step one into step two', async () => {
    const result = await draftStory.run({}, { write: async instruction => `<${instruction}>` });
    expect(result).toEqual({
      outline: '<Outline a short story.>',
      draft: '<Write it from: <Outline a short story.>>',
    });
  });
});
