---
'@arki/contracts': patch
'@arki/async': patch
---

Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
