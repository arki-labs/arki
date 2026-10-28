import { defineFailure, invariant } from '@arki/failure';

import { STRING_ERROR_CODES, StringError } from './errors.js';

/**
 * Minimal `{{ name }}` templating for flat values. No expressions, no dotted
 * paths, no recursion. Output is plain text; escape separately when needed.
 */

export type TemplateValues = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** A template references an absent own key or an undefined value.
 * @fix Provide every referenced value, or explicitly choose missing: keep or empty.
 * @verify bun run test -- src/edit.test.ts src/fluent.test.ts
 */
export const MissingValue = defineFailure('string.missing_value', {
  status: 400,
  message: 'A template value is missing.',
  remediation: 'Provide every referenced value, or explicitly choose missing: keep or empty.',
});

const MISSING_POLICIES = ['fail', 'keep', 'empty'] as const;

export type InterpolateOptions = Readonly<{
  /** What to do for a placeholder without a value: return a failure (`fail`, default), `keep` it, or render `empty`. */
  missing?: (typeof MISSING_POLICIES)[number];
}>;

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/**
 * Replaces `{{ name }}` placeholders with `values[name]`. `null` renders as
 * `''`; `undefined` counts as missing. `\{{` emits a literal `{{` and `\\`
 * a literal backslash. Missing values return `MissingValue`; malformed
 * placeholders throw `StringError` (`ARKI_STRING_E004`).
 */
export function interpolate(template: string, values: TemplateValues, options: InterpolateOptions = {}) {
  const missing = options.missing ?? 'fail';
  invariant(
    MISSING_POLICIES.includes(missing),
    'Interpolation missing policy must be fail, keep or empty.',
  );
  let output = '';
  let index = 0;

  while (index < template.length) {
    if (template.startsWith('\\{{', index)) {
      output += '{{';
      index += 3;
      continue;
    }
    if (template.startsWith('\\\\', index)) {
      output += '\\';
      index += 2;
      continue;
    }
    if (!template.startsWith('{{', index)) {
      output += template[index] ?? '';
      index += 1;
      continue;
    }

    const close = template.indexOf('}}', index + 2);
    if (close === -1)
      throw new StringError(STRING_ERROR_CODES.invalidTemplate, `Unterminated placeholder at index ${String(index)}`);
    const raw = template.slice(index, close + 2);
    const key = template.slice(index + 2, close).trim();
    if (!IDENTIFIER.test(key)) throw new StringError(STRING_ERROR_CODES.invalidTemplate, `Invalid placeholder ${raw}`);

    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) {
      if (missing === 'fail') return MissingValue();
      if (missing === 'keep') output += raw;
    } else {
      output += value === null ? '' : String(value);
    }
    index = close + 2;
  }

  return output;
}
