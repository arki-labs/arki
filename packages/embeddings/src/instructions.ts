import type { Instruction } from './types.js';

/**
 * Qwen3-Embedding was trained with this prefix on queries and none on documents.
 *
 * @example
 * createOpenAICompatibleModel({ id: 'my-model', baseURL, dimensions: 1024, instruction: QWEN3_INSTRUCTION });
 */
export const QWEN3_INSTRUCTION: Instruction = {
  query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
  document: '',
  version: 1,
};

/**
 * Symmetric models (OpenAI, the fake): text goes in as it is.
 *
 * @example
 * createOpenAICompatibleModel({ id: 'my-model', baseURL, dimensions: 768, instruction: NO_INSTRUCTION });
 */
export const NO_INSTRUCTION: Instruction = { version: 0 };
