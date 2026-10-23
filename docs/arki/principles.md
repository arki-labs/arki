# Arki core principles

These principles apply to every `@arki/*` package and to Dot plugins and features.
Arki is a complete application framework optimized for agents, workflows and AI
products. AI is a core stack capability on the frontend and backend (A-12).
They are accepted design requirements. The [execution record](../features/arki-framework/.work/progress.md)
tracks implementation; acceptance does not imply that every package already complies.
The six additions and broader application verification were accepted on
2026-10-20 in [A-37](decisions.md#framework-consolidation-2026-10-19).
Typed identities and branded domain values were added in A-38 on the same date.
One dedicated integration per backend was added in A-42 on 2026-10-23.
The checklist form of every principle, with the founder rules that have no
A-number, is the `arki-library-principles` skill in `.agents/skills/`.

## Define once, infer everywhere

Inputs, successful outputs, failures and service contracts have one source.
Composition and adapters infer their types from that source. Preserve exact unions
and ordinary success values. See [A-33 and A-34](decisions.md#framework-consolidation-2026-10-19).

Verification must catch lost inference, widened failure unions and drift between
runtime schemas and their source types through real consumer compositions.

## Give identities and domain values distinct types

Every kind of ID has a distinct domain type throughout the application, including
internal IDs, external provider IDs, UUIDs and numeric IDs. Different ID kinds must
not be interchangeable just because their underlying values share a format.
The same domain identity keeps one type across layers.
Use nominal brands where the representation alone cannot distinguish them; a
renamed `string` alias does not establish identity.

Prefer branded types for other strings with domain meaning or validation rules:
email addresses, URLs, slugs, paths, tenant keys and external references. Choose
brands for semantic distinctions that prevent mistakes. Ordinary free text can
remain `string`; closed sets use their source-defined literal union when that
already captures the distinction.

Define each domain type once at its owning schema or definition. Infer it in
tables, services, actions, RPC, jobs, AI tools and UI. Generators and validated
constructors produce that type; external values pass through its canonical
parser, with typed failures for invalid input. Do not manufacture brands with
unchecked casts or repeat their declarations at each layer.

Preserve domain types across composition and persistence adapters. Wire and
database values retain their existing representation; the receiving codec or
validated storage contract restores the domain type from its source definition.
A compile-time brand does not replace runtime validation or authorization.

A brand that public signatures name is a TypeScript type, not a Zod brand. Declare
it with a `unique symbol`: `declare const positionBrand: unique symbol;` and
`type Position = string & { readonly [positionBrand]: true }`. The schema that makes
it is `z.custom<Position>(value => is(value, base))`, where `base` holds the real
check. It sits in the package's `./zod` entry, and an exact two-way type test locks
it to the type. So public `.d.ts` files never name Zod (`TYPES_E001`), the check
stays a schema, and the brand comes from one place, never from a cast (A-43).

Verification rejects cross-kind ID assignment, including IDs with identical
formats, and raw values passed to branded APIs. Exact inference tests and real
storage/transport round trips prove that brands survive composition and are
restored at boundaries. Existing prefix-only IDs and plain-string domain values
remain migration work until those checks pass.

## Schemas own validation

Every check that turns an unknown value into a typed one comes from a schema.
Zod (the default), Valibot, ArkType and any other Standard Schema validator are
the authority. Arki adds no validation vocabulary of its own. This covers HTTP and
RPC input, config and env, JSON, storage reads, queue and workflow payloads, AI
tool arguments and model output, and any parameter typed `unknown`.

The schema is also the type's source: the type is inferred from it, never restated.
One schema serves both failure channels with the same issues:

- Expected bad input returns a typed failure: `parse(schema, value)` gives `InvalidInput`.
- A bad value that means a bug throws: `assert(value, schema)` narrows in place, and
  `ensure(value, schema)` returns the schema's output.
- Small structural checks are schemas too: `is(value, recordSchema)`, never a
  hand-written `typeof value === 'object'` guard. A zero-dependency package that
  cannot take Zod writes a hand-written Standard Schema.

Out of scope: preconditions on values that are already typed, such as finite or
range checks on a `number` parameter in a hot path, use `invariant` or plain code.
Exhaustive switches use `unreachable`. Only schema implementations and
`@arki/schema` itself inspect raw shapes by hand, plus the packages that cannot
import it: `@arki/failure` (`@arki/schema` depends on it), `@arki/log` (kept
zero-dependency) and `@arki/bench` (dev tooling). They keep plain checks and do
not copy schemas locally, because local copies would recreate the duplicates. See [A-39](decisions.md#framework-consolidation-2026-10-19).

Verification rejects hand-written type guards, validator helpers and ad-hoc
`isX(value: unknown)` functions on unknown values. Existing copies are migration work.

Secrets follow the same rule. The schema says which keys are secret, with
`secret()`; nothing else keeps a list. Tracked env files hold those values
encrypted, and `dot env check` reads the schema to refuse a plaintext one.
Values are decrypted before the schema parses them, and the schema refuses
anything still encrypted.

## Own failures and execution

Every fallible public operation exposes typed outcomes. Owned boundaries supervise
defects, cancellation and cleanup; callers preserve failures until an explicit
policy handles them. See [error ownership](decisions.md#error-ownership-and-foundation-direction).

Verification covers partial acquisition, cancellation, late settlements and
cleanup failures. No failed service may be published as a successful dependency.

## Prove portability

Runtime support is an export-level capability, verified with real consumers.
Keep server capabilities explicit and support the runtimes an entry advertises.
See A-35 in the [decision ledger](decisions.md#framework-consolidation-2026-10-19).

A library whose root is server-side offers what an oRPC contract needs (failures,
ids, schemas) through one browser-safe `./contract` entry, checked by bundling it
for the browser. See A-41.

Prove representative complete application journeys from published artifacts, too:
authentication, persistence, background work, AI and recovery must work together
in a cold consumer without private workspace knowledge. Before publication, use
the exact packed release candidate and record its identity; do not imply that it
is already published. Preserve each entry's explicit runtime requirements.

Verification exercises real exports and types as well as complete journeys.
Missing runtimes, skipped checks and unverified integrations remain visible gaps.

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

## Start small; grow through composition

A useful feature needs little ceremony. Adding persistence, workflows, AI or
multiple transports extends its existing structure. Packages remain usable
independently, and Dot composes their capabilities. Applications own infrastructure
and provider choices; business logic remains straightforward to extract from Dot.

Verification demonstrates the same business capability in a small script and a
composed application without maintaining two implementations.

## Share execution; make authority explicit

HTTP requests, scheduled jobs, CLI commands and AI tools invoke the same business
capabilities through owned execution. Each boundary explicitly establishes
principal, tenant, permissions, approvals and available credentials. Shared
business logic does not imply shared exposure or permission policy.

A model selecting a tool grants no authority. Tool descriptions are metadata;
application code enforces authorization. Approval is bound to the permitted
operation and its scope, including when work is resumed or retried.

Verification proves that exposing an existing action to an agent neither
duplicates business logic nor grants broader access. Untrusted arguments cannot
expand the caller's authority.

## The application can explain itself

Expose a machine-readable application graph derived from actual definitions:
capabilities, dependencies, schemas, failures, runtime requirements and exposure
policies. Humans, development agents, documentation and operator tools consume
that same graph. Distinguish runtime status from declared capabilities, and apply
access controls and secret redaction to inspection.

Verification demonstrates that `dot explain` can answer what calls a capability,
what can fail and why it is unavailable without a separately maintained inventory.
Declared graph relationships must remain distinguishable from observed calls.

## Preserve business truth across interruptions

Accepted, running, completed, failed, cancelled and uncertain are distinct
outcomes. Durable work has stable identities, versioned persisted contracts and
explicit retry and reconciliation policies. Document delivery guarantees and
require idempotency where effects may repeat; do not promise universal exactly-once
external effects.

Telemetry is diagnostic evidence. Durable business records remain authoritative.
Uncertain external writes must be reconciled before replay.

Verification covers a payment that succeeds before a crash prevents its response
from being recorded: recovery reconciles the payment instead of charging again.
Equivalent interruption tests apply to other durable effects.

## Make behavior reproducible

Time, randomness, models and external services have controllable testing
interfaces. Failures, cancellation, streams and restart behavior can be tested
without paid models or real waiting. Fakes have contract tests; real integrations
have separate verification.

Verification turns a workflow bug into a repeatable regression test with a
controlled sequence of events. A passing fake-provider test does not establish
that a remote integration works.

## Make resource costs explicit and bounded

Agent runs have limits on time, attempts, concurrency, tool calls and model
spending. Child work respects the parent's remaining limits, including parallel
children. Cancellation propagates; limitations of noncooperative dependencies
and provider cost estimates are explicit. Actual usage and uncertain usage remain
distinguishable.

Framework overhead has measured budgets for bundle size, startup, memory and
TypeScript/editor performance. Precise types must remain practical in large
applications; performance improvements must preserve their precision.

Verification proves that nested or parallel agent calls cannot silently multiply
the caller's budget, and that representative large applications stay within
recorded runtime and compiler budgets.

## One dedicated integration per backend

Each backend a package supports (a store, an event log, a pub/sub, a driver,
a provider) is its own subpath module that the application imports and uses
directly, the way `drizzle-orm/node-postgres` and `drizzle-orm/pglite` are
imported: `@arki/journal/postgres`, `@arki/pubsub/pg`, `@arki/pubsub/sqlite`.
The module owns its code and its queries. There is no shared runtime layer
that several backends run through, no union-typed helper that picks its SQL at
runtime and no generic backend with a dialect switch. Some query text repeating
between backends is accepted. See [A-42](decisions.md#framework-consolidation-2026-10-19).

Sharing plain declarations remains fine: a column list, a schema, a contract
test suite that every backend must pass. The rule is against runtime layers,
not against shared facts. Platform dependencies of a backend entry are
optional peers, and a portable entry reaches one only through a lazy import.

Verification runs the same contract test suite against every backend and
checks that each backend entry imports no other backend's module and no
shared "any backend" runtime helper.
