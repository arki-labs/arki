---
'@arki/journal': minor
---

Job verbs for operators: `journal.jobs(db, { status, effect, limit })` lists pending or dead jobs, `journal.retry(db, jobId)` brings a dead job back and wakes the workers, `journal.discard(db, jobId)` deletes a dead job. Both refuse a job that is not dead.
