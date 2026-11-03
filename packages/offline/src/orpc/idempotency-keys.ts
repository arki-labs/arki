import { pgColumns } from '@arki/db/pg';

import { createIdempotencyTable } from './idempotency-table.js';

/** The idempotency table in Postgres's default schema. For another schema, call `createIdempotencyTable(pgColumns(schema))`. */
export const idempotencyKeys = createIdempotencyTable(pgColumns());
