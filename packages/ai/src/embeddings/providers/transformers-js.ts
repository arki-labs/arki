/**
 * transformers.js on-device embedding provider.
 *
 * Backed by `@huggingface/transformers` v4+ (the renamed successor to the
 * legacy `@xenova/transformers` v2). Runs ONNX-quantized embedding models
 * locally in Node or the browser; v4 ships a WebGPU C++ runtime that gives
 * ~4× BERT throughput vs WASM.
 *
 * Persona-5 stack from the STATE-OF-THE-ART survey:
 *   - `Xenova/all-MiniLM-L6-v2`         — 22M, 384-d (smallest)
 *   - `Xenova/bge-small-en-v1.5`        — 33M, 384-d
 *   - `nomic-ai/nomic-embed-text-v1.5`  — 137M, 768-d MRL (recommended)
 *   - `Xenova/gte-small`                — 33M, 384-d
 *
 * The model is loaded once on the first call and cached in-process. Heavy
 * dynamic-import — apps that never instantiate this provider won't pay the
 * ONNX runtime cost.
 */

import { BaseEmbeddingProvider  } from '../base';
import type {BaseEmbeddingConfig} from '../base';
import { EmbeddingError, getErrorMessage } from '../../errors';

export type TransformersJsEmbeddingConfig = BaseEmbeddingConfig & {
  /** Hugging Face model id (e.g. `nomic-ai/nomic-embed-text-v1.5`). */
  model?: string;
  /** Reported embedding dimension. Must match the model. */
  dimensions?: number;
  /** Quantization for the ONNX run. Default: `q8`. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Pooling strategy applied to token embeddings. Default: `mean`. */
  pooling?: 'mean' | 'cls' | 'none';
  /** L2-normalize the output vectors. Default: true. */
  normalize?: boolean;
  /** Override the runtime device. `auto` picks WebGPU when available. */
  device?: 'auto' | 'cpu' | 'gpu' | 'webgpu' | 'wasm';
};

const DEFAULT_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
const DEFAULT_DIMS = 768;

type FeatureExtractionPipeline = (
  texts: string | string[],
  options: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ tolist(): number[][] | number[] }>;

export class TransformersJsEmbeddingProvider extends BaseEmbeddingProvider {
  protected readonly providerLabel = 'transformers-js';
  private readonly modelId: string;
  private readonly dims: number;
  private readonly dtype: NonNullable<TransformersJsEmbeddingConfig['dtype']>;
  private readonly pooling: NonNullable<TransformersJsEmbeddingConfig['pooling']>;
  private readonly normalize: boolean;
  private readonly device: TransformersJsEmbeddingConfig['device'];
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(config: TransformersJsEmbeddingConfig = {}) {
    super(config);
    this.modelId = config.model ?? DEFAULT_MODEL;
    this.dims = config.dimensions ?? DEFAULT_DIMS;
    this.dtype = config.dtype ?? 'q8';
    this.pooling = config.pooling ?? 'mean';
    this.normalize = config.normalize !== false;
    this.device = config.device ?? 'auto';
  }

  getDimensions(): number {
    return this.dims;
  }

  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    try {
      const output = await pipe(texts, {
        pooling: this.pooling,
        normalize: this.normalize,
      });
      const raw = output.tolist();
      // For a batch input, transformers.js returns number[][]; for a single
      // string it returns number[]. Normalize to number[][].
      if (texts.length === 1 && !Array.isArray(raw[0])) {
        return [raw as number[]];
      }
      return raw as number[][];
    } catch (error) {
      throw new EmbeddingError(
        `transformers.js feature-extraction failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        // @ts-expect-error - optional peer dependency
        const mod = (await import('@huggingface/transformers')) as unknown as {
          pipeline: (
            task: 'feature-extraction',
            model: string,
            options?: { dtype?: string; device?: string },
          ) => Promise<FeatureExtractionPipeline>;
        };
        return mod.pipeline('feature-extraction', this.modelId, {
          dtype: this.dtype,
          device: this.device,
        });
      })();
    }
    return this.pipelinePromise;
  }
}
