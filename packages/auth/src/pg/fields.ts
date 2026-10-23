/**
 * The runtime half of "types written once": the engine learns the exposed user columns from the
 * app's Drizzle table, so nothing is declared twice.
 */
import type { BetterAuthOptions } from 'better-auth';
import { getTableColumns } from 'drizzle-orm';

import type { AuthTable } from './types.js';
import { AUTH_ERROR_CODES, AuthError } from '../errors.js';

/** The engine's description of extra user fields. */
export type AdditionalFields = NonNullable<NonNullable<BetterAuthOptions['user']>['additionalFields']>;
type FieldAttribute = AdditionalFields[string];
type FieldType = FieldAttribute['type'];

const invalid = (message: string): never => {
  throw new AuthError(AUTH_ERROR_CODES.invalidConfig, `[@arki/auth] ${message}`);
};

const isPrimitiveDefault = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The engine field type for a Drizzle column type, e.g. `'string enum'` → its values. */
function fieldTypeOf(name: string, dataType: string, enumValues: readonly string[] | undefined): FieldType {
  const [kind, constraint] = dataType.split(' ');
  if (kind === 'string') {
    return constraint === 'enum' && enumValues !== undefined && enumValues.length > 0 ? [...enumValues] : 'string';
  }
  if (kind === 'number') return 'number';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'object' && constraint === 'date') return 'date';
  if (kind === 'object' && constraint === 'json') return 'json';
  return invalid(`User column "${name}" has type "${dataType}", which the engine cannot carry. Expose another column.`);
}

/**
 * The engine's `user.additionalFields` for the exposed columns: required when the column is
 * `NOT NULL` without a default, settable by the client only when listed in `signUpFields`, and
 * returned unless `returned` is `false` (the session's own columns stay server-side). A name that
 * is not a column of the table is `ARKI_AUTH_E001`.
 */
export function additionalFieldsFromColumns(
  table: AuthTable,
  fields: readonly string[],
  signUpFields: readonly string[],
  returned = true,
): AdditionalFields {
  const columns = getTableColumns(table);
  const result: AdditionalFields = {};
  for (const name of fields) {
    const column = Object.hasOwn(columns, name) ? columns[name] : undefined;
    if (column === undefined) invalid(`\`user.fields\` names "${name}", which is not a column of the user table.`);
    else {
      const enumValues: unknown = Reflect.get(column, 'enumValues');
      const values =
        Array.isArray(enumValues) && enumValues.every(value => typeof value === 'string') ? enumValues : undefined;
      const defaultValue: unknown = column.default;
      result[name] = {
        type: fieldTypeOf(name, column.dataType, values),
        required: column.notNull && !column.hasDefault,
        input: signUpFields.includes(name),
        returned,
        ...(isPrimitiveDefault(defaultValue) && { defaultValue }),
      };
    }
  }
  return result;
}
