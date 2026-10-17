---
'@arki/dot': minor
---

Plugins no longer take a `version` field. `plugin({ version })` and `PluginManifest.version` are gone, `dot explain` has no VERSION column, the graph labels show only the plugin name, and the `dot.plugin.version` span attribute is no longer set. Migrate: delete `version` from your `plugin()` calls. The app `version` in `defineApp(name, { version })` stays.
