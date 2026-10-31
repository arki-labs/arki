import type { Schema } from 'ai';
import { jsonSchema } from 'ai';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, orThrow, UnexpectedFailure } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import { inputJsonSchema } from '../input-json-schema.js';

/**
 * Turns a caller's Standard Schema into the schema the AI SDK sends to a model and checks the
 * model's answer with.
 *
 * - The model is shown the schema's INPUT JSON Schema, because the model writes raw JSON. A
 *   schema that transforms (`z.string().transform(Number)`) is described by what goes in.
 * - The model's JSON is then run through `parseAsync`, so the caller gets the schema's OUTPUT
 *   (the transformed value). Bad JSON becomes an explicit `UnexpectedFailure` carrying canonical input issues.
 *
 * `where` names the call site in the error thrown when the schema cannot describe itself.
 */
export function modelSchema<S extends StandardSchemaV1>(schema: S, where: string): Schema<SchemaOutput<S>> {
  return jsonSchema<SchemaOutput<S>>(inputJsonSchema(schema, where), {
    validate: async value => {
      const result = await parseAsync(schema, value);
      if (InvalidInput.is(result)) return { success: false, error: new UnexpectedFailure(result) };
      return { success: true, value: orThrow(result) };
    },
  });
}
