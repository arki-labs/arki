import type { Instruction } from './types.js';

/** Qwen3-Embedding was trained with this prefix on queries and none on documents. */
export const QWEN3_INSTRUCTION: Instruction = {
  query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
  document: '',
  version: 1,
};

/** Symmetric models (OpenAI, the fake): text goes in as it is. */
export const NO_INSTRUCTION: Instruction = { version: 0 };
