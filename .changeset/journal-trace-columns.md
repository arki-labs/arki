---
'@arki/journal': minor
---

Every recorded event now carries a trace the library stamps: `commandId` (the `cmd_` run that wrote it), `causeSeq` (inside an effect's `ctx.run`, the event the job was for) and `correlationId` (one per chain, inherited from the cause event or the parent run; `journal.run` and `journal.bind` take `{ correlationId }` to seed it with a request id). The command context exposes `commandId` and `correlationId`.

Schema change, additive: three nullable columns and one index on `journal_events`. Apps that own the tables regenerate their migration. The SQL is:

```sql
ALTER TABLE journal_events ADD COLUMN command_id varchar;
ALTER TABLE journal_events ADD COLUMN cause_seq bigint;
ALTER TABLE journal_events ADD COLUMN correlation_id varchar;
CREATE INDEX journal_events_correlation_id_idx ON journal_events (correlation_id);
```
