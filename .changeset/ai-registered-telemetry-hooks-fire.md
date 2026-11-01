---
'@arki/ai': patch
---

An app's `registerTelemetry` hooks (`@arki/ai/sdk`) fire again for `@arki/ai` calls. Since spans became the default, every call passed its own span integration, and the AI SDK uses a call's own integrations in place of the global ones, so a registered hook (provider, tokens, cost per call) never ran. Each call now lists the registered integrations next to the span integration, read at the call. Spans stay on by default; `AI_TELEMETRY=off` still turns them off, and registered hooks then run as the SDK runs them.

no demo impact: the `registerTelemetry` hooks in drop-studio and faultline (the X-ray `ai.call` events) fire again with no change to either demo.
