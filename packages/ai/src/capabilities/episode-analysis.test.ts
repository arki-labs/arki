import { expect, test } from 'vitest';

import type { StandardSchemaV1 } from '@arki/schema';
import { isFailure, orThrow } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import type { StructuredLLMProvider } from '../ai-service/types';
import { RateLimited } from '../failures';
import type { TranscriptDocument } from './episode-analysis';
import { analyzeEpisode, validateTranscript } from './episode-analysis';

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
const answering = (answer: unknown): StructuredLLMProvider => ({
  ...provider,
  async generateStructuredData<S extends StandardSchemaV1>(_prompt: string, schema: S) {
    return orThrow(parseAsync(schema, answer));
  },
});
const provider: StructuredLLMProvider = {
  async generateStructuredData<S extends StandardSchemaV1>(_prompt: string, schema: S) {
    return orThrow(parseAsync(schema, output));
  },
  async generateStructuredDataFromMessages() {
    throw new Error('Unexpected call');
  },
  async generateText() {
    throw new Error('Unexpected call');
  },
  streamConversation() {
    throw new Error('Unexpected call');
  },
};
test('shared episode capability returns grounded intervals and all neutral speakers', async () => {
  const result = orThrow(await analyzeEpisode(transcript, 'revision', { model: 'test' }, provider));
  expect(result.chapters[0]?.end).toBe(10);
  expect(result.speakers).toEqual([{ id: 'speaker-0', name: null, evidence: null }]);
  expect(result.version).toBe('revision');
});
// A bad transcript is the caller's outside input: a returned InvalidInput, never a thrown Error or ZodError.
test('shared capability refuses empty intervals before provider generation', async () => {
  const result = await analyzeEpisode(
    { ...transcript, segments: [{ ...transcript.segments[0]!, end: 0 }] },
    'revision',
    {},
    provider,
  );
  expect(isFailure(result) && result.code).toBe('schema.invalid_input');
});
test('validateTranscript returns InvalidInput for a transcript the schema or the maximum refuses', () => {
  const malformed = validateTranscript({ ...transcript, duration: Number.NaN }, 60);
  expect(isFailure(malformed) && malformed.code).toBe('schema.invalid_input');
  const tooLong = validateTranscript(transcript, 5);
  expect(isFailure(tooLong) && tooLong.code).toBe('schema.invalid_input');
  expect(isFailure(validateTranscript(transcript, 60))).toBe(false);
});
// Model output that is not in the source must never reach the listener as an analysis.
test('a summary that is not an exact source excerpt is UngroundedOutput', async () => {
  const result = await analyzeEpisode(transcript, 'revision', {}, answering({ ...output, summary: 'Forests are evil.' }));
  expect(isFailure(result) && result.code).toBe('ai.ungrounded_output');
});
test('a provider failure is returned as it came', async () => {
  const limited: StructuredLLMProvider = { ...provider, generateStructuredData: async () => RateLimited({}) };
  const result = await analyzeEpisode(transcript, 'revision', {}, limited);
  expect(isFailure(result) && result.code).toBe('ai.rate_limited');
});
