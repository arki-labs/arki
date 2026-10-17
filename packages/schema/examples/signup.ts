// #region field-errors
import * as v from 'valibot';

import { parse, pathOf, SchemaError } from '@arki/schema';

const Signup = v.object({ name: v.string(), age: v.number() });

/** Turn bad form input into one message per field. A broken schema is not bad data, so it passes through. */
export function fieldErrors(input: unknown): Record<string, string> {
  try {
    parse(Signup, input);
    return {};
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    const errors: Record<string, string> = {};
    for (const issue of error.issues) errors[pathOf(issue).map(String).join('.')] = issue.message;
    return errors;
  }
}
// #endregion field-errors
