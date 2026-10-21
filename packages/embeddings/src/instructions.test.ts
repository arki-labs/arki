import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { Instruction, Purpose } from './types.js';
import {
  E5_INSTRUCTION,
  EMBEDDINGGEMMA_INSTRUCTION,
  NO_INSTRUCTION,
  NOMIC_INSTRUCTION,
  QWEN3_INSTRUCTION,
} from './instructions.js';
import { createOllamaModel } from './ollama/index.js';

const PURPOSES: readonly Purpose[] = ['query', 'document', 'similarity', 'classification', 'clustering'];

/** The prefix each purpose gets, `''` for none: what actually reaches the model. */
const prefixes = (instruction: Instruction) =>
  Object.fromEntries(PURPOSES.map(purpose => [purpose, instruction[purpose] ?? '']));

/**
 * Every prefix set ever shipped, keyed `name@version`. A vector embedded with one prefix is only
 * comparable to vectors embedded with the same prefix, and `instructionVersion` in the space id is
 * the only thing that tells two prefix sets apart. So a shipped row is frozen: to change a prefix,
 * bump the instruction's `version` and add a row. Never edit a row.
 */
const SHIPPED: Readonly<Record<string, Readonly<Record<Purpose, string>>>> = {
  'qwen3@1': {
    query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    document: '',
    similarity: '',
    classification: '',
    clustering: '',
  },
  'embeddinggemma@1': {
    query: 'task: search result | query: ',
    document: 'title: none | text: ',
    similarity: 'task: sentence similarity | query: ',
    classification: 'task: classification | query: ',
    clustering: 'task: clustering | query: ',
  },
  'nomic@1': {
    query: 'search_query: ',
    document: 'search_document: ',
    similarity: '',
    classification: 'classification: ',
    clustering: 'clustering: ',
  },
  'e5@1': { query: 'query: ', document: 'passage: ', similarity: '', classification: '', clustering: '' },
  'none@0': { query: '', document: '', similarity: '', classification: '', clustering: '' },
};

const INSTRUCTIONS = {
  qwen3: QWEN3_INSTRUCTION,
  embeddinggemma: EMBEDDINGGEMMA_INSTRUCTION,
  nomic: NOMIC_INSTRUCTION,
  e5: E5_INSTRUCTION,
  none: NO_INSTRUCTION,
} as const;

describe('instruction table', () => {
  // A changed prefix silently moves every new vector into another space; only a new
  // instructionVersion makes the space id, and so `isSameSpace`, notice.
  it.each(Object.entries(INSTRUCTIONS))('%s: a changed prefix needs a new version', (name, instruction) => {
    expect(prefixes(instruction), `${name}@${instruction.version} differs from what shipped: bump version`).toEqual(
      SHIPPED[`${name}@${instruction.version}`],
    );
  });

  // Each Ollama model must be queried with the prefixes it was trained with, or recall drops.
  it.each([
    ['qwen3-embedding:0.6b', 'qwen3@1'],
    ['embeddinggemma', 'embeddinggemma@1'],
    ['nomic-embed-text', 'nomic@1'],
  ])('snapshot per model and purpose: %s', (id, shipped) => {
    const model = createOllamaModel({ id });
    if (isFailure(model)) throw new Error(model.message);
    expect(prefixes(model.instruction)).toEqual(SHIPPED[shipped]);
  });
});
