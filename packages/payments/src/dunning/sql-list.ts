import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * `(a, b, c)` with one bound parameter per value, for `column IN ${valueList(...)}`.
 * An array bound as one parameter does not reach Postgres as an array on every driver.
 * An empty list matches nothing.
 */
export function valueList(values: readonly string[]): SQL {
  if (values.length === 0) return sql`(NULL)`;

  return sql`(${sql.join(
    values.map(value => sql`${value}`),
    sql`, `,
  )})`;
}
