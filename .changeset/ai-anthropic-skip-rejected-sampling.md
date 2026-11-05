---
'@arki/ai': patch
---

`AnthropicService` no longer sends `temperature` to Claude models that reject sampling parameters
(Haiku 5.5, Sonnet 5.5/5, Opus 5.5/5/4.8/4.7, Fable 5.x, Mythos 5.x). Those requests failed with a 400.
A per-call `temperature` on such a model is dropped with a debug log. Other models are unchanged.

no docs impact: public API unchanged.
no demo impact: no demo sets a temperature on these models.
