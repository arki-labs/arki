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

/**
 * EmbeddingGemma's task prompts, from its model card. A document's title is unknown here, so it is
 * `none`, as the card says to write it.
 *
 * @example
 * createOllamaModel({ id: 'embeddinggemma' }).instruction === EMBEDDINGGEMMA_INSTRUCTION; // true
 */
export const EMBEDDINGGEMMA_INSTRUCTION: Instruction = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
  classification: 'task: classification | query: ',
  clustering: 'task: clustering | query: ',
  similarity: 'task: sentence similarity | query: ',
  version: 1,
};

/**
 * Gemini Embedding 2's prefixes (ai.google.dev/gemini-api/docs/embeddings, read 2026-10-21). Today
 * they equal EmbeddingGemma's, but each model keeps its own `version`, so one model card changing a
 * prefix re-embeds only that model's corpora.
 */
export const GEMINI_EMBEDDING_2_INSTRUCTION: Instruction = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
  classification: 'task: classification | query: ',
  clustering: 'task: clustering | query: ',
  similarity: 'task: sentence similarity | query: ',
  version: 1,
};

/**
 * nomic-embed-text's task prefixes. It has none for similarity, so that purpose goes in as it is.
 *
 * @example
 * createOllamaModel({ id: 'nomic-embed-text' }).instruction === NOMIC_INSTRUCTION; // true
 */
export const NOMIC_INSTRUCTION: Instruction = {
  query: 'search_query: ',
  document: 'search_document: ',
  classification: 'classification: ',
  clustering: 'clustering: ',
  version: 1,
};

/**
 * The E5 family (`intfloat/e5-*`, `multilingual-e5-*`): `query: ` on queries, `passage: ` on documents.
 *
 * @example
 * createOpenAICompatibleModel({ id: 'intfloat/multilingual-e5-large', baseURL, dimensions: 1024, instruction: E5_INSTRUCTION });
 */
export const E5_INSTRUCTION: Instruction = { query: 'query: ', document: 'passage: ', version: 1 };
