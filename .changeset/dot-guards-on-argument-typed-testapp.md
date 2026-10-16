---
'@arki/dot': minor
---

Wiring errors land on the argument, with the `DOT:` label in the message. `.use()`, `.serve()`, `.useAll()` and `.features()` no longer demand a phantom second argument when a unit cannot mount (`Expected 2 arguments, but got 1`); the plugin or list itself fails to type-check, and the error names the missing or colliding keys. `testPlugin(...).boot()` does the same through a `this` type. `ListGuard` is exported.

`testApp(plugins)` and `bootTestApp(plugins)` infer `app.services` from the plugin tuple and refuse a tuple that would not mount; a runtime-built array gives the open record. Breaking: the explicit `testApp<TServices>()` type argument is gone — drop it, the services are read off the plugins.
