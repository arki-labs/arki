---
'@arki/ai': patch
---

The Anthropic default model is now `claude-sonnet-5-5` (was `claude-3-5-haiku-latest` in `createLLMProvider`, `claude-3-5-sonnet-latest` in `AnthropicService`, `claude-3-haiku-20240307` in the provider router). `LLM_MODEL` still overrides it. New exports: `DEFAULT_ANTHROPIC_MODEL` and `resolveLlmModel()`, which returns the model id `createLLMProvider` would use.
