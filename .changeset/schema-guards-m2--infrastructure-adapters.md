---
'@arki/queue': patch
'@arki/auth': patch
'@arki/db': patch
'@arki/schedule': patch
'@arki/live': patch
---

Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
