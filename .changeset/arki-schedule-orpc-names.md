---
'@arki/schedule': minor
---

Rename three `@arki/schedule/orpc` exports so names say what they do: `cronContract()` is now `defineCronContract()`, `cronRouter()` is now `cronRouterFor()`, and `validated()` is now `checkOnly()`. The old `cronContract` and `cronRouter` clashed with the names apps give their own exports, so apps had to alias them. `validated` hid that it returns the original value, not the parsed one. Behaviour is unchanged.
