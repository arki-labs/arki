import type { StandardSchemaV1 } from '@arki/schema';
import { parseAsync } from '@arki/schema';
import { expect, test } from 'vitest';

import type { StructuredLLMProvider } from '../ai-service/types';
import type { TranscriptDocument } from './episode-analysis';
import { analyzeEpisode } from './episode-analysis';

const transcript: TranscriptDocument = {
  language: 'en',
  duration: 10,
  provider: 'test',
  model: 'test',
  segments: [{ start: 0, end: 10, text: 'Forests provide shade.', speaker: 'speaker-0' }],
};
const output = {
  summary: 'Forests provide shade.',
  chapters: [{ start: 0, end: 10, title: 'Forests', evidence: 'Forests provide shade.' }],
  topics: ['Forests'],
  entities: [],
  pips: [],
  speakers: [],
};
const provider: StructuredLLMProvider = {
  async generateStructuredData<S extends StandardSchemaV1>(_prompt: string, schema: S) {
    return parseAsync(schema, output);
  },
  async generateStructuredDataFromMessages() {
    throw new Error('Unexpected call');
  },
  async generateText() {
    throw new Error('Unexpected call');
  },
  async *streamConversation() {
    throw new Error('Unexpected call');
  },
};
test('shared episode capability returns grounded intervals and all neutral speakers', async () => {
  const result = await analyzeEpisode(transcript, 'revision', { model: 'test' }, provider);
  expect(result.chapters[0]?.end).toBe(10);
  expect(result.speakers).toEqual([{ id: 'speaker-0', name: null, evidence: null }]);
  expect(result.version).toBe('revision');
});
test('shared capability refuses empty intervals before provider generation', async () => {
  await expect(
    analyzeEpisode({ ...transcript, segments: [{ ...transcript.segments[0]!, end: 0 }] }, 'revision', {}, provider),
  ).rejects.toThrow();
});
