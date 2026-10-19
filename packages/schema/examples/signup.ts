// #region field-errors
import * as v from 'valibot';

import { InvalidInput, orThrow } from '@arki/failure';
import { parse, pathOf } from '@arki/schema';

const Signup = v.object({ name: v.string(), age: v.number() });

/** Turn invalid form input into field messages; schema defects cross this throwing form adapter explicitly. */
export function fieldErrors(input: unknown): Record<string, string> {
  const result = parse(Signup, input);
  if (!InvalidInput.is(result)) {
    orThrow(result);
    return {};
  }
  const errors: Record<string, string> = {};
  for (const issue of result.data.issues) errors[pathOf(issue).map(String).join('.')] = issue.message;
  return errors;
}
// #endregion field-errors
