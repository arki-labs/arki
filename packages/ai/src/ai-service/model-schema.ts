import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import type { Schema } from 'ai';

import { parseAsync, SchemaError } from '@arki/schema';
import { jsonSchema } from 'ai';

import { inputJsonSchema } from '../input-json-schema';

/**
 * Turns a caller's Standard Schema into the schema the AI SDK sends to a model and checks the
 * model's answer with.
 *
 * - The model is shown the schema's INPUT JSON Schema, because the model writes raw JSON. A
 *   schema that transforms (`z.string().transform(Number)`) is described by what goes in.
 * - The model's JSON is then run through `parseAsync`, so the caller gets the schema's OUTPUT
 *   (the transformed value). Bad JSON becomes a `SchemaError` carrying `issues`.
 *
 * `where` names the call site in the error thrown when the schema cannot describe itself.
 */
export function modelSchema<S extends StandardSchemaV1>(schema: S, where: string): Schema<SchemaOutput<S>> {
  return jsonSchema<SchemaOutput<S>>(inputJsonSchema(schema, where), {
    validate: async value => {
      try {
        return { success: true, value: await parseAsync(schema, value) };
      } catch (error) {
        // Only bad model output is a failed validation. A validator that throws is a bug: let it propagate.
        if (error instanceof SchemaError) return { success: false, error };
        throw error;
      }
    },
  });
}
