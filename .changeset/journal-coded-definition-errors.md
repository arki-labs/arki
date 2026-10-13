---
'@arki/journal': minor
---

Definition mistakes now throw `JournalError` with the new code `BAD_DEFINITION`, not a plain `Error`. This covers a bad event type, entity kind or effect name, a bad key column, a duplicate `.create` or `.on`, a need named `db`, `jobId`, `signal` or `run`, a duplicate effect or projection name, and a missing service in `compose`. They are thrown when the declaration runs, so tools such as `dot explain` can show the code. The message text is unchanged, and now follows the code and a short summary. Match on `error.code`, not the message.
