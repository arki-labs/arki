# Upgrade action boundaries

1. Keep each business failure's canonical definition at its source. Replace
   handwritten unions and code arrays with references to those definitions.
2. Choose a reusable `action` descriptor or retain an independent native contract.
   Share schemas by reference when the operations are equivalent.
3. Bind the usecase with `bindAction` on the server. Keep service closures out of
   browser contract imports. Declare adapter exposure, principal, approval and retry.
4. Use `run` for unknown input. Use `handle` after native input parsing, and let
   that transport validate and encode successful output exactly once.
5. Build RPC errors with `errorMap`, throw through `orThrowRpc`, and revive with
   the same canonical definitions. Declare HTTP failures on the route; handle
   canonical failure values instead of inspecting legacy HTTP error strings.
6. Check auth policy outcomes with `isFailure`. Preserve masked resource access
   and transport challenge/retry headers. An authenticated principal attestation
   is established by trusted middleware, never by the caller's body.
7. Make retry ownership explicit. Action retry policy describes permission;
   execution does not retry. Update HTTP client callers for typed failure values,
   including unknown-code and invalid-payload protocol refusals.
8. Register an OTel SDK and context manager once at app entry if exporting
   telemetry. Use `$telemetry` in plugin contexts or `telemetryFor(feature)`;
   avoid wrapping an already instrumented transport/provider operation again.

For executable authoring and exact source fixtures, see [actions](./actions.md).
The MCP `asTool` annotation reuses contracts but does not execute them; its runtime
adapter remains outside this slice. See [MCP contracts](../../mcp/docs/contracts.md).
