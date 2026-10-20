---
'@arki/http': minor
'@arki/auth': minor
---

RPC error maps retain their original failure definitions for exact revival by another contract adapter. Use `rpcFailureDefinitions` to read these references; wire JSON remains unchanged.

Add reusable browser-safe action contracts, server execution ownership and scoped
OpenTelemetry helpers. Native RPC/HTTP adapters parse and encode once while
sharing canonical failures and explicit exposure, principal and approval policies.

Breaking: HTTP boundaries and auth policies return typed canonical failure values;
update callers that inspect legacy strings or expect thrown refusals. Retry
ownership is explicit. MCP adds browser-safe contract annotations and callable
tools that reuse the gateway's typed native client, preserve canonical failures,
and enforce access, approval and result budgets. Hosts provide approval authority;
the full MCP server and durable confirmation store remain separate work.
