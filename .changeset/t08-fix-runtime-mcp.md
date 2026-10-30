---
'@arki/mcp': patch
---

The tool policy in `meta.mcp` is checked by a schema (`mcpPolicySchema`) instead of hand-written guards. Calls refused before the gateway (forbidden, approval required, cancelled) leave a debug log on `arki:mcp`. `@arki/log` and `zod` are now dependencies.
