/**
 * Inside a Dot app, a transaction a usecase opens through `transactions()`
 * runs in a `db.transaction.once` span under the usecase's span. So a trace
 * shows which usecase held the transaction. Real PGlite, real Dot.
 */
import { defineRelations, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { db, transactions } from './dot.js';

const notes = pgTable('notes', { id: text('id').primaryKey() });
const database = db({ driver: 'pglite', memory: true, relations: defineRelations({ notes }) });

const ledger = defineFeature('ledger')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(transactions(database.provides.db))
  .usecases({
    add:
      ({ transaction }) =>
      (id: string) =>
        transaction(async tx => {
          await tx.insert(notes).values({ id });
          return id;
        }),
  })
  .entrypoints();

describe('@arki/db spans inside a Dot app', () => {
  it('nests db.transaction.once under the Dot usecase span, so a trace shows which usecase held the transaction', async () => {
    using spans = captureSpans();
    const app = orThrow(await defineApp('db-telemetry').infra(database).features([ledger]).start());
    try {
      await app.services.db.execute(sql`create table notes (id text primary key)`);
      expect(await app.services['ledger.usecases'].add('n1')).toBe('n1');
    } finally {
      orThrow(await app.dispose());
    }

    expect(spans.named('db.transaction.once').parent).toBe(spans.named('feature.ledger.add'));
  });
});
