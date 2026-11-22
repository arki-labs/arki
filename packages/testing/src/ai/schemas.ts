/**
 * The answer shapes the judge reads from Ollama, as zod schemas. The two the judge asks for (`verdictSchema`,
 * `claimsSchema`) also describe themselves as JSON Schema through zod's Standard JSON Schema support: Ollama
 * constrains its output with it. Internal: the TS types in `answers.ts` are the source, and
 * `../schemas.test-d.ts` locks `verdictSchema` and `checkedClaimSchema` to them.
 */
import { z } from 'zod';

export const verdictSchema = z.object({ pass: z.boolean(), reason: z.string() });

export const checkedClaimSchema = z.object({ claim: z.string(), supported: z.boolean(), quote: z.string() });

export const claimsSchema = z.object({ claims: z.array(checkedClaimSchema) });

const installedModelSchema = z.object({ name: z.string(), digest: z.string() });

/**
 * What `GET /api/tags` returns that the kit reads: each installed model's name and digest. A model without a
 * name or a digest cannot be matched, so it is left out rather than failing the list; a missing list is empty.
 */
export const tagsAnswerSchema = z
  .object({
    models: z
      .array(z.union([installedModelSchema, z.record(z.string(), z.unknown()).transform(() => null)]))
      .nullish(),
  })
  .transform(({ models }) => ({ models: (models ?? []).filter(model => model !== null) }));

/** What `POST /api/chat` returns that the judge reads: the text of the answer. */
export const chatAnswerSchema = z
  .object({ message: z.object({ content: z.string() }) })
  .transform(answer => ({ content: answer.message.content }));

/** What `POST /api/embed` returns that the embedder reads: one vector of numbers per text. */
export const embedAnswerSchema = z.object({ embeddings: z.array(z.array(z.number())) });
