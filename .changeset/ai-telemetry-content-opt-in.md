---
"@arki/ai": minor
---

Generation spans no longer record prompts and model output by default. `aiTelemetry` now passes `recordInputs: false` and `recordOutputs: false` to the AI SDK, so `gen_ai` spans keep the model, function id, token usage and finish reason but not the prompt, the completion, tool arguments or tool results. An app opts in with `AI_TELEMETRY_RECORD_CONTENT=on`; any other value keeps content out, and `AI_TELEMETRY=off` still turns the spans off. Migration: a debug or bench run that reads `gen_ai.input.messages`, `gen_ai.output.messages` or `gen_ai.system_instructions` from spans sets `AI_TELEMETRY_RECORD_CONTENT=on`.

Docs: README `## Observability` lists the `ai.vector.<operation>`, `ai.transcribe`, `ai.mastra.run_tool_loop` and `ai.reconcile` spans; `docs/reference.md` no longer says tool-loop spans need `OTEL_EXPORTER_OTLP_ENDPOINT`.
