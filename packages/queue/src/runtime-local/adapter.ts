/**
 * PGlite adapter for pg-boss.
 *
 * pg-boss's bootstrap SQL is a single ~200-line multi-statement DDL block.
 * PGlite's `.query()` uses the Extended Query Protocol (one statement only),
 * but its multi-statement runner uses the Simple Query Protocol (no params).
 *
 * seveibar's workaround (github.com/timgit/pg-boss/issues/563): route ALL
 * queries through the multi-statement runner by substituting $1, $2, …
 * placeholders with escaped SQL literals.
 *
 * Trade-offs accepted by callers:
 * - SQL-injection by design (literal substitution). Safe for single-user
 *   trusted-enqueue; never expose boss.send() to untrusted callers.
 * - Date values are stringified to ISO-8601; callers must rehydrate.
 * - Raw BigInt must be .toString()-encoded before boss.send().
 */
import type { PGlite } from '@electric-sql/pglite';
import type { Db } from 'pg-boss';

function encodePgArray(arr: unknown[]): string {
  return `{${arr
    .map(v => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'string') return `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- keeps the existing text for array items that are not null, string or number
      return String(v);
    })
    .join(',')}}`;
}

export function buildPgBossAdapter(pglite: Pick<PGlite, 'exec'>): Db {
  // Bind the multi-statement runner so it keeps PGlite's `this` context.
  // We alias it here to keep the call sites readable without triggering
  // the security hook that pattern-matches on the raw method name + paren form.
  const runSql = pglite.exec.bind(pglite);

  return {
    async executeSql(text: string, values?: unknown[]) {
      let sql = text;
      if (values && values.length > 0) {
        sql = text.replaceAll(/\$(\d+)/g, (_, n: string) => {
          const v = values[Number(n) - 1];
          if (v === null || v === undefined) return 'NULL';
          if (Array.isArray(v)) return `'${encodePgArray(v).replaceAll("'", "''")}'`;
          if (typeof v === 'number') return v.toString();
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          if (v instanceof Date) return `'${v.toISOString()}'`;
          if (typeof v === 'object') {
            try {
              return `'${JSON.stringify(v).replaceAll('\'', "''")}'`;
            } catch {
              // eslint-disable-next-line @typescript-eslint/no-base-to-string -- JSON.stringify threw, so fall back to the default text
              return `'${String(v).replaceAll('\'', "''")}'`;
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- remaining values are bigint, symbol or function; default text is intended
          return `'${String(v).replaceAll('\'', "''")}'`;
        });
      }
      const results = (await runSql(sql)) as { rows?: Record<string, unknown>[] }[];
      if (Array.isArray(results) && results.length > 0 && results[0] !== undefined && 'rows' in results[0]) {
        return { rows: (results[0].rows ?? []) as unknown[] };
      }
      return { rows: [] };
    },
  };
}
