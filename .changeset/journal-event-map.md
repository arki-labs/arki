---
'@arki/journal': minor
---

`dot explain --as journal-flow` is now `dot explain --as event-map`, and the graph covers the whole flow. Breaking (0.x, no shims):

- Renamed: the format `journal-flow` to `event-map`, `JournalFlow*` types to `EventMap*`, `JOURNAL_FLOW_*` constants to `EVENT_MAP_*`. The manifest projection loads `@arki/journal/event-map`.
- New nodes: `command`, `entrypoint`. New edges: `writes` (command to event), `waits-for` (a workflow's `.waitFor` event), `runs` (a workflow's `.command` node, with `undo: true` for its `undo`), `calls` (a procedure file imports a command). A workflow node lists its `.step` names as `opaqueSteps`: a `ctx.run` inside a step is not drawn.
- New Node-only entry `@arki/journal/event-map`: `project(manifest, cwd?)`, `scanEntrypoints({ root })`, and `checkEventMapFile({ file, mermaid, update? })`. The scan reads the procedure files under `src/features/**/entrypoints/**` (set `journal({ j, entrypointRoot })` for another root), follows relative imports, and keeps the exports that are journal commands. A command imported and never called is still an edge.
- `@arki/journal/projection`: `project` is now `projectGraph(manifest)` and returns `{ document, entrypointRoot }` without the scan. New: `withEntrypoints`, `edgeKey`, and `eventMapMermaid(document)`, which prints Mermaid `flowchart LR` in a stable order. `render` also prints writers, workflow nodes, entrypoints and the files the scan could not read.
- `checkEventMapFile` keeps a Mermaid file in an app's docs fresh: it returns the diff when the file is stale, and writes it when `update` is true.

See the upgrade note (section 21).
