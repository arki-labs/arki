---
'@arki/ai': minor
---

The agent runtime can now be cancelled, and tools can declare the shape of what they return.

- `runToolLoop` takes an optional `signal`. Once it aborts, the run starts no new model call or tool call, the model call in flight is aborted, and the loop rejects with the signal's reason. Both the AI SDK and the Mastra runtime honour it.
- A tool's `execute` now gets a second argument, `{ signal }`. Pass it to `fetch` and other slow work.
- A tool can declare `output` (Zod or any Standard Schema). The runtime checks the result against it before the model sees it. A mismatch fails the tool call with a new `ToolOutputError` (code `TOOL_OUTPUT_ERROR`).
- New `defineAgentTool` helper: `execute`'s input type comes from `inputSchema` and its return type from `output`.
- The AI SDK runtime records one span per model step and one per tool call through the AI SDK's own telemetry, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Nothing changes without it.
- `aiTelemetry` no longer throws where there is no `process` (browsers, Hermes).
