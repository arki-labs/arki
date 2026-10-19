# Arki core principles

These principles apply to every `@arki/*` package and to Dot plugins and features.
They are accepted design requirements. The [execution record](../features/arki-framework/.work/progress.md)
tracks implementation; acceptance does not imply that every package already complies.

## Define once, infer everywhere

Inputs, successful outputs, failures and service contracts have one source.
Composition and adapters infer their types from that source. Preserve exact unions
and ordinary success values. See [A-33 and A-34](decisions.md#framework-consolidation-2026-10-19).

## Own failures and execution

Every fallible public operation exposes typed outcomes. Owned boundaries supervise
defects, cancellation and cleanup; callers preserve failures until an explicit
policy handles them. See [error ownership](decisions.md#error-ownership-and-foundation-direction).

## Prove portability

Runtime support is an export-level capability, verified with real consumers.
Keep server capabilities explicit and support the runtimes an entry advertises.
See A-35 in the [decision ledger](decisions.md#framework-consolidation-2026-10-19).

## Everything can be observed with OpenTelemetry

**Everything can be instrumented; everything that should be instrumented is
instrumented by default.** This is a framework-wide requirement, not a Dot-only
integration. A-36 records the founder's decision.

- Instrument meaningful operational boundaries: lifecycle phases, requests,
  usecases, database and provider calls, jobs, workflow attempts, AI calls, tools,
  streams, retries and cleanup. Use traces, metrics and correlated logs where
  each explains behavior. Reuse existing instrumentation for the same boundary;
  do not emit duplicate spans around an already instrumented operation.
- Make custom instrumentation easy. Plugins and features receive a small, typed,
  context-aware surface for spans, events, metrics and log correlation, scoped
  from their existing identities. Authors should not repeat names, thread tracing
  boilerplate through every function, or reach into a global SDK. Standalone
  package use must support standard OpenTelemetry integration too.
- Preserve execution context across asynchronous work and adapter boundaries,
  using propagation or links as appropriate for jobs, retries and durable work.
  Instrument owned execution without changing its lifetime or result.
- Keep SDKs, exporters, sampling and telemetry destinations under app control.
  Libraries do not configure or install a global SDK. Without configured
  telemetry, their observability surface remains safe to call and does no export
  I/O. The integration must respect each entry's supported runtimes.
- Record typed failures as classified outcomes without manufacturing exception
  events. Keep defects distinct. Instrumentation or exporter failures must not
  replace application results, hide failures, or recursively report themselves.
- Use stable names, bounded metric dimensions and safe attributes. Secrets,
  prompts, model responses and user payloads are not collected by default;
  capturing content requires an explicit application policy.

Instrumentation is a deliberate boundary decision, not a span for every pure
helper or arithmetic operation. Each package records which boundaries are
instrumented and why others need no separate instrumentation. Pure work remains
observable through its enclosing operation and optional custom instrumentation.

Verification covers default instrumentation, easy custom instrumentation,
parent/context propagation, exact failure classification, absence of duplicate
spans and unchanged behavior with telemetry absent or failing. Package coverage
and runtime evidence belong to the [framework plan](../features/arki-framework/.work/plans/2026-10-19-framework.md),
particularly T05, T08 and T16.
