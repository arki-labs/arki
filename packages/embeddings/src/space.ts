import type { EmbeddingModel, EmbeddingSpace, Quantization } from './types.js';

const QUANTIZATION_TAG = { float32: 'f32', int8: 'i8', binary: 'bin' } as const satisfies Record<Quantization, string>;

/**
 * The space as one readable string, e.g. `'ollama/qwen3-embedding:0.6b@<digest>/1024/l2/f32/i1'`.
 * Apps store it next to every vector, so the format never changes.
 *
 * @example
 * await db.insert(indexes).values({ spaceId: spaceId(batch.space) });
 */
export function spaceId(space: EmbeddingSpace): string {
  const revision = space.revision === undefined ? '' : `@${space.revision}`;
  const norm = space.normalized ? 'l2' : 'raw';
  return `${space.provider}/${space.model}${revision}/${space.dimensions}/${norm}/${QUANTIZATION_TAG[space.quantization]}/i${space.instructionVersion}`;
}

/**
 * True when vectors from `a` and `b` are comparable. `revision` counts only when both sides know it.
 *
 * @example
 * if (!isSameSpace(storedSpace, embedder.space)) throw new Error('re-embed the corpus');
 */
export function isSameSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimensions === b.dimensions &&
    a.normalized === b.normalized &&
    a.quantization === b.quantization &&
    a.instructionVersion === b.instructionVersion &&
    (a.revision === undefined || b.revision === undefined || a.revision === b.revision)
  );
}

/** The space a model produces at the given output options. Read again after a call: Ollama learns its revision lazily. */
export function spaceOf(model: EmbeddingModel, dimensions: number, quantization: Quantization): EmbeddingSpace {
  const space = {
    provider: model.provider,
    model: model.id,
    dimensions,
    normalized: model.normalized,
    quantization,
    instructionVersion: model.instruction.version,
  };
  return model.revision === undefined ? space : { ...space, revision: model.revision };
}
