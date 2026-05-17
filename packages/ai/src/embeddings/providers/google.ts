/**
 * Google Gemini embedding provider.
 *
 * Backed by `@ai-sdk/google`. Default model `gemini-embedding-001`
 * (3072-d MRL, 2K context, MMTEB 68.32 — public cloud-API leader).
 *
 * Use Vertex (`@ai-sdk/google-vertex`) when you need EU residency, SOC 2 with
 * enterprise SLAs, or HIPAA BAA. This module targets the Google AI Studio /
 * Generative Language API surface.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';

export type GoogleEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `gemini-embedding-001`, `text-embedding-005`. */
  model?: string;
  baseURL?: string;
  /** Output dimensions (Matryoshka). Default 3072; common alternatives: 768, 1536. */
  dimensions?: number;
};

const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_DIMS = 3072;

export class GoogleEmbeddingProvider extends AiSdkEmbeddingProvider {
  constructor(config: GoogleEmbeddingConfig = {}) {
    const google = createGoogleGenerativeAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    super({
      ...config,
      label: 'google',
      model: google.textEmbeddingModel(config.model ?? DEFAULT_MODEL),
      dimensions: config.dimensions ?? DEFAULT_DIMS,
    });
  }
}
