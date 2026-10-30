# @arki/journal API reference: constants, codes and helpers

The [README](../README.md) and the [agent guide](agent-guide.md) teach the journal by task. This page covers the exports you meet at the edges: the tag constants, the error code tables, the webhook error class and the event graph helpers. Each entry says what it is and when you import it.

## Jobs table

- `JOB_KINDS` (`@arki/journal/pg`): the three kinds of row in `journal_jobs`: `'effect'`, `'queue'` and `'forward'`. An effect row is one effect run. A queue row is a job scheduled by `@arki/queue/outbox`. A forward row is one write's events on their way to an outside log. Import it when you filter or count jobs by kind, for example in an operator screen or a metrics query. The type `JobKind` is inferred from it.

## Workflows

- `WORKFLOW_LIMIT_PREFIX` (`@arki/journal`): the string `'workflow/'`. A workflow's own concurrency limit is named with this prefix and the workflow name. A shared `j.limit` name may not start with it. Import it when you read limit state and need to tell a workflow's own limit from a shared one, or when you check a limit name before you create it.

## Dot plugin

- `JOURNAL_ACTION_META_SCHEMA` (`@arki/journal/dot`): the schema tag `'@arki/journal/action-meta@1'`. Every journal action in a Dot manifest carries it in its metadata. Import it when you write a tool that reads a manifest and wants to pick out journal actions.
- `JOURNAL_PROJECTIONS_KIND` (`@arki/journal/dot`): the string `'journal-projections'`. It marks the infra unit that `journalProjections(...)` makes, so the journal can find it among a feature's units. Import it when you scan a feature's units yourself.
- `JOURNAL_PLUGIN_ERROR_CODES` (`@arki/journal/dot`): the stable error codes of the Dot plugin, keyed by name. `badSlice` is `ARKI_JOURNAL_PLUGIN_E001`: a feature gave the journal an invalid contribution. Each code has a `@fix` note in the source. Match on these codes in tests and in boot error handling. Never parse the message text.

## Outgoing webhooks

These come from `@arki/journal/http/webhooks`. See [Outgoing webhooks](../README.md#outgoing-webhooks) for the sender itself.

- `WebhookError`: the error class the webhook sender throws. It has a `code` string and a message that starts with `webhooks:`. Import it to catch webhook failures with `instanceof` and then switch on `code`.
- `WEBHOOK_ERROR_CODES`: the table of codes `WebhookError` uses. Match on these, never on messages.
  - `badInput` (`ARKI_JOURNAL_WEBHOOK_E001`): an input failed its schema, a payload is not JSON, or a URL is not public https.
  - `notInTransaction` (`ARKI_JOURNAL_WEBHOOK_E002`): `dispatch` got the root database. It needs the business transaction.
  - `notFound` (`ARKI_JOURNAL_WEBHOOK_E003`): no subscription or message has this id.
  - `otherPartner` (`ARKI_JOURNAL_WEBHOOK_E004`): `replay` named a message and a subscription of different partners.
  - `badEncryptionKey` (`ARKI_JOURNAL_WEBHOOK_E005`): `encryptionKey` is not 32 bytes of base64.
  - `deliveryFailed` (`ARKI_JOURNAL_WEBHOOK_E006`): the subscriber answered with a status other than 2xx. The worker retries it.

## Event map

The graph behind `dot explain --as event-map`. The README shows the printed output, and the agent guide's Dot part explains it. The portable parts come from `@arki/journal/projection`. The parts that read the filesystem come from `@arki/journal/event-map`, which is Node-only.

From `@arki/journal/projection`:

- `projectGraph(manifest)`: builds the app's graph from a Dot manifest's projections, without the scan. Returns `{ document, entrypointRoot }`. It merges every journal the app mounts. Each node and edge appears once. Import it when you want the declared graph as data in a browser or an edge runtime.
- `withEntrypoints(document, scanned, problems)`: adds scan results to a document: an `entrypoint` node per file, a `command` node per command, the `writes` and `calls` edges.
- `render(document)`: turns a document into the text that `dot explain --as event-map` prints: per event, its writers and consumers with timing, owner, deps and retry; then each workflow's nodes, each entrypoint's commands, and the files the scan could not read.
- `eventMapMermaid(document)`: the graph as Mermaid `flowchart LR` text, in a stable order, ending in a newline. Arrows follow the data. After-commit links are dotted. Feature nodes and `owned-by` edges are left out.
- `edgeKey(edge)`: the key that makes an edge unique (`kind from to node label undo`).
- `EVENT_MAP_NODE_KINDS`: `'event'`, `'entity'`, `'projection'`, `'effect'`, `'tap'`, `'workflow'`, `'feature'`, `'command'`, `'entrypoint'`.
- `EVENT_MAP_EDGE_KINDS`: `'writes'` (command writes event), `'folds'`, `'projects'`, `'reacts'` (effect, tap or workflow reacts to event; a workflow's `startOn`), `'waits-for'` (workflow waits for event), `'runs'` (workflow runs command; `undo: true` for an undo), `'calls'` (entrypoint imports command), `'owned-by'`. In an edge, `from` is the subject and `to` the object.
- `EVENT_MAP_TIMINGS`: when a consumer runs: `'same-transaction'` (inside the write) or `'after-commit'`.
- `EVENT_MAP_DELIVERIES`: how often an after-commit consumer sees an event: `'exactly-once'`, `'at-least-once'` or `'at-most-once'`.
- Types: `EventMapGraph`, `EventMapNode`, `EventMapEdge`, `EventMapDocument`, `EventMapMeta`, `EventMapProblem`, `EventMapScanEntry`.

From `@arki/journal/event-map` (Node only; it uses `node:fs`):

- `project(manifest, cwd?)`: what Dot loads for `dot explain --as event-map`. It is `projectGraph` plus the scan of the manifest's `entrypointRoot`, resolved against `cwd` (default `process.cwd()`).
- `scanEntrypoints({ root })`: reads the procedure files under the absolute folder `root`. Returns `{ entries, problems }`.
- `checkEventMapFile({ file, mermaid, update? })`: compares `mermaid` with the file. Returns `{ state: 'fresh' }`, `{ state: 'written' }` (when `update` is true), or `{ state: 'stale' | 'missing', diff }`.
- `render`: the same function as in `@arki/journal/projection`.

`journal({ j, entrypointRoot })` sets the folder the scan reads, relative to the folder `dot` runs in (default `'src/features'`).
