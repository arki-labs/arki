---
'@arki/ai': patch
---

User-scoped Anthropic keys (`sk-ant-usr…`) work. Anthropic rejects every request from such a key unless it names a workspace. Set the new optional env var `ANTHROPIC_WORKSPACE_ID` and every Anthropic provider `@arki/ai` builds sends the `anthropic-workspace-id` header: `createLLMProvider`, `AnthropicService` and the provider router. `@arki/ai/anthropic` now exports its own `createAnthropic` and `anthropic`, which add the header. Workspace-scoped keys need nothing, and the header is left off.
