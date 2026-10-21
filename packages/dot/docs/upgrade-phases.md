# Upgrade typed phases

This is a breaking minor release while Dot is pre-1.0. Rebuild `@arki/dot` and
packages that emit its types, then typecheck consumers. The lifetime migration
in [Upgrade owned lifetimes](upgrade-ownership.md) still applies.

## Check configure before reading the manifest

`configure()` now returns a configured app or its inferred configure refusal or
canonical `UnexpectedDefect`. It remains synchronous and performs no I/O.
Replace direct `.configure().manifest` access with a failure check:

```ts run
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure } from '@arki/failure';

const catalog = defineFeature('catalog').provides({ catalog: () => ({ ready: true }) }).entrypoints();
const configured = defineApp('shop').features([catalog]).configure();
if (isFailure(configured)) throw new Error(configured.code); // Example's process boundary.
const manifest = configured.manifest;
if (manifest.app.name !== 'shop') throw new Error('wrong manifest');
const app = await configured.boot();
if (isFailure(app)) throw new Error(app.code);
const disposed = await app.dispose();
if (isFailure(disposed)) throw new Error(disposed.code);
```

Inside application code, return the failure unchanged. At a process or protocol
boundary, translate it into an unsuccessful exit or safe response. Tests and an
explicit exception boundary may use `orThrow`; a wrapper that throws every
returned failure erases the contract.

## Keep each phase's outcomes

The compiler infers refusals from the actual callbacks across unit, object
feature, `defineFeature`, `initUnits`, `entrypoint`, rename and app builder forms.
Avoid annotating them with a broad `Failure` return or a manually restated union.
Providers expose only their successful service values. Failed providers never
enter the registry; each completed unit publishes its services atomically.

| Operation             | Success        | Failures reachable from this entry point                                                                                                    |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder `configure()` | Configured app | Configure refusals and `UnexpectedDefect`.                                                                                                  |
| Builder `boot()`      | Booted app     | Configure outcomes, then provider/usecase construction and boot outcomes; rollback can add disposal failures in an aggregate.               |
| Configured `boot()`   | Booted app     | Provider/usecase construction and boot outcomes; configure callbacks do not run again.                                                      |
| Builder `start()`     | Started app    | Configure and boot outcomes, then start refusals and supervisor outcomes; rollback can add stop/disposal failures.                          |
| Configured `start()`  | Started app    | Boot and start outcomes; configure callbacks do not run again.                                                                              |
| Booted app `start()`  | `undefined`    | Start refusals and supervisor outcomes; rollback can add stop/disposal failures. Provider and configure refusals are excluded.              |
| App `stop()`          | `undefined`    | Stop refusals and supervisor outcomes, aggregated when several fail.                                                                        |
| App `dispose()`       | `undefined`    | Stop/dispose refusals, owned cleanup failures and supervisor outcomes, aggregated when several fail. Configure/start refusals are excluded. |

Supervisor outcomes include canonical defects and owned cancellation/deadline
outcomes where that work can reach them. Do not replace the inferred types with
one application-wide failure union.

If startup fails, Dot joins owned work and rolls back resources before returning.
Successful rollback returns the primary failure unchanged. Failed rollback
returns an inferred `ScopeAggregate`: local `cause.primary` and `cause.cleanup`
retain the ordered failures; public data contains safe counts. Private causes do
not survive serialization. Stop and dispose continue every finalizer and return
managed failures. Neither throws a managed refusal or hook defect.

Same-transition calls coalesce; different transitions remain serialized. Failed
and disposed apps require a fresh builder. Disposal returns its cached outcome.
`createAppRuntime` never caches a failed start as ready, and failed prior disposal
blocks replacement ownership until release is resolved.

## Author hooks with concrete returns

Configure, start, stop and dispose hooks return `undefined` or a concrete typed
failure; async hooks resolve the same values. Boot additionally accepts ownership
plans. Ordinary inline empty sync and async hooks remain valid. Detached
callbacks typed as `void` or `Promise<void>` can hide a returned failure and are
rejected: author the callback inline, or explicitly return `undefined` from the
detached function. A configure callback must never return a Promise. Mounting also checks spread
replacements: boot callbacks retain concrete outcomes and valid ownership plans,
and replacement factories preserve the successful shapes carried by their handles.
Adapter functions must preserve their inferred unit returns. For overloads,
derive each return with `ReturnType` from its implementation helper; a broad
`Unit` annotation discards the actual callback contracts.

Unknown or broad `Failure` factory results cannot prove an exact refusal union
and are rejected. Keep factory returns inferred, or validate untyped external
input with the canonical source schema before returning it.

## Separate usecase creation from invocation

A `.usecases(...)` factory refusal fails construction and is part of boot's
outcome. A returned usecase's business refusal belongs to invocation, rather than
boot. Invocation preserves that refusal's identity and adds `UnexpectedDefect`
for unknown throws or native Promise rejections, even with tracing disabled.
Known refusals are reported without manufacturing exception events; a broken
telemetry reporter cannot replace or recursively report the primary failure.
Dependent generic call signatures and overload sets cannot preserve their return
relationships through supervision; unsupported signatures are diagnosed. Expose
concrete supported call signatures instead of casting around the diagnostic.
Invocation returns must also be concrete: `void`, `Promise<void>` and `unknown`
can erase a business refusal. For a usecase with no result, return `undefined`
explicitly; validate external values before returning them.

## Move activation and diagnostics to their boundaries

Logging activation now happens during boot. Configure and `dot explain` never
activate the logging slot or evaluate its configuration thunk. Hook OTel context
is active while hook work runs; scope versions come from package metadata.

Legacy `ARKI_DOT_E*` IDs remain stable. Kernel-generated lifecycle defects
retain a private diagnostic cause with phase, owner and original cause. Owned
provider/boot task defects retain their original private cause; diagnostics
record the phase, owner and legacy ID. Match top-level failures by canonical definition. Static declarations
outside a managed boundary can still throw. Managed CLI module loading catches
module-evaluation defects; an unmanaged static import does not gain that boundary.

CLI consumers must inspect resolved failures. A failed managed `dot _preflight --json` report exits 3 with `dot.preflight_failed`; its full payload moves to
`.error.data.{app,migrations,report,failure}`. Successful reports keep their
existing `.data` shape. `dot dev` consumes the failure envelope and starts no
runner. Doctor also treats failed disposal as an unsuccessful check.

Request, job and durable workflow adapter migrations remain separate work; this
release does not claim those integrations are complete.

## Bridge existing exception-based adapters explicitly

At legacy oRPC or HTTP handlers whose contracts do not yet declare canonical
failures, use `orThrow(await usecase(...))` at that boundary. Existing declared
domain failures still use `orThrowRpc`. Internal calls check `isFailure` and
return the same value. A Drizzle transaction callback also needs an explicit
exception bridge until its returned-failure rollback migration lands in T06.
Do not hide this choice inside a proxy or a global unwrapping helper.

Cron oRPC routes send `UnexpectedDefect` to their existing `failed` policy before
success mapping. Ordinary successful values need no extra responder; declared
business refusals still keep their explicit mapping.

Custom logging slots infer failures from both activation and `close()`. Check
those outcomes through app boot/disposal. When adapting a foreign
`close(): Promise<void>` API, use an inline async close method that awaits it;
the method's completed result is explicitly empty. Returned close failures are
preserved in the cleanup outcome, even when a reporting sink also throws.
