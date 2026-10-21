# Design principles

DOT is built around six principles. They are the standard every API,
error message, and PR is measured against. When two paths exist, pick the
one that honors the principles. When a principle and a convenience
conflict, **the principle wins**.

> Coding agents working in this repo: treat these as load-bearing
> constraints. Do not invent new API surface that violates them. Do not
> rewrite error messages to be more "professional." Do not soften
> language to be more "neutral."

---

## 1. Slightly playful, very precise

> **Linus-Torvalds energy: short, dense, has a personality.**

DOT is allowed to sound like a human wrote it. Names earn their meaning;
identifiers and error messages have a voice. The framework is not corporate
and not committee-shaped.

**Playful** does _not_ mean cute, ironic, or whimsical for its own sake.
It means _human_. A real developer wrote this. They cared. They had taste.

**Precise** means every word is the _right_ word. `unit` not "module." `boot`
not "initialize." `dispose` not "cleanup." `dot doctor` not "validate." If
a shorter, more accurate word exists, use it. If a longer word adds
meaning, accept the length.

This means we:

- Pick **short, dense identifiers** that name the concept directly. One word
  whenever one word will carry it.
- Treat **error messages as part of the API**. Every error tells the
  developer what went wrong, what to do about it, and where to read more.
  No "An error occurred." No `e.message` fallbacks.
- Allow a **light hand in JSDoc** — examples can be vivid, comparisons can
  be concrete, asides are allowed if they teach. We trust the reader.
- **Refuse buzzwords** (`seamless`, `best-in-class`, `enterprise-grade`,
  `next-generation`). They mean nothing.
- **Refuse hedging language** in core docs (`you might want to…`,
  `consider…`, `feel free to…`). DOT has opinions; state them.

What this principle _forbids_:

- Generic, committee-shaped naming (`Unit`, `Manager`, `Provider`,
  `Helper`, `Util`).
- Apology-shaped error messages ("Sorry, something went wrong").
- Filler that makes prose longer without making it clearer.

---

## 2. Units ARE the app — no hidden core

There is no framework "underneath" the units. Remove every unit and you
remove the app. The kernel composes units; it does not contain the app's
behavior.

This means we:

- Never add **framework-reserved service kinds** that "always work" without
  a unit publishing them. If you want `services.logger`, a unit publishes it.
- Never add **hidden lifecycle hooks** that run outside the 5-hook
  sequence (`configure → boot → start → stop → dispose`).
- Never put **app behavior in defaults**. Defaults can shape _config_; they
  cannot shape _what the app does_.

What this principle _forbids_:

- A global "DOT context" that units read from without declaring it.
- "Built-in" services that bypass the registration protocol.
- Magic auto-loading of units from the filesystem.

---

## 3. Deterministic by default

Same input, same declaration order, same outcome. Every time. On every
machine. The manifest is byte-identical across runs of the same source.
Boot order, dispose order, and diagnostic output never vary.

This means we:

- **Boot in declaration order**; dispose in reverse. Never sort by
  insertion time, name, or hash.
- **Never read the clock during boot.** Timestamps belong in the envelope's
  `generatedAt`, not in package contents.
- **Never use `Date.now()` or `Math.random()` for identifiers** the manifest
  surfaces. Stable IDs only — derived from inputs.
- **Iterate `Map`/`Set` and rely on insertion order**, never assume host
  ordering.

What this principle _forbids_:

- "Eventual consistency" between units during boot.
- Race-prone boot sequences disguised as `Promise.all`.
- Logs / diagnostics that include `new Date().toISOString()` inside the
  package body (it belongs at the envelope edge, once).

---

## 4. Agent-discoverable everywhere

Coding agents are first-class consumers. Every command emits a JSON
envelope. Every error has a stable code, severity, remediation, and
`docsUrl`. The static graph lives on `app.manifest`; the runtime snapshot
lives on `app.diagnostics`. Both are inspectable without running the app.

This means we:

- Every CLI command supports `--json`. Every JSON envelope follows the same
  shape: `{ status, command, generatedAt, summary, items, errors }`.
- Every `ReleaseError` / `DiagnosticIssue` / lifecycle failure has a
  **stable error code** (e.g. `ARKI_DOT_E003`). Codes are part of the
  public API.
- Every error has a **`remediation` string** that tells you what to do, and
  a **`docsUrl` string** that points at the page that explains it.
- Every public type is **importable** — no hidden shapes that an agent
  would need to reverse-engineer from runtime output.

What this principle _forbids_:

- `throw new Error('...')` with no code.
- "See the docs" without a URL.
- Log-scraping as a test assertion. Tests assert on the envelope.

---

## 5. The kernel has zero optional dependencies

`@arki/dot` ships with `@arki/async`, `@arki/cli`, `@arki/clock`,
`@arki/contracts`, `@arki/failure`, `@arki/log`, `@arki/schema`,
`@opentelemetry/api` and `zod`. That is the entire dependency surface. Adapters (database,
queue, auth, event-sourcing) live in their own packages and depend on
`@arki/dot` as an _optional peer_.

This means we:

- **Never bundle adapter code into the kernel.** A user who only needs
  pipe composition pays for nothing else.
- **Adapters break in isolation.** If `@arki/db` has a bug, an app using
  only `@arki/kv` is unaffected.
- **Each adapter declares `@arki/dot` as `peerDependencies` with
  `peerDependenciesMeta.optional: true`.** The adapter only loads when both
  packages are installed.

What this principle _forbids_:

- "Bring-your-own-everything" config in the kernel that pretends to be
  optional but ships as part of the package.
- Cross-adapter deps (e.g., `@arki/db` requiring `@arki/kv`). Adapters are
  composed at the _app_ layer, not chained in source.

---

## 6. Schemas own validation

Every check that turns an unknown value into a typed one comes from a
schema. Zod is the default; any Standard Schema validator (Valibot, ArkType)
works. Dot adds no validation vocabulary of its own. The schema is also the
source of the type: Dot infers it, never restates it.

This means we:

- Validate **every boundary with a schema**: oRPC and HTTP input, config and
  env, job and workflow payloads, storage reads, AI tool arguments and model
  output, and anything typed `unknown`.
- Use **one schema for both failure channels.** Expected bad input returns
  a typed failure with `parse(schema, value)` (`InvalidInput`, HTTP 400). A
  bad value that means a bug throws with `assert(value, schema)` or
  `ensure(value, schema)` from `@arki/schema` (a defect, HTTP 500).
- Write **structural checks as schemas too**: `is(value, recordSchema)`,
  never a hand-written guard.

What this principle _forbids_:

- Hand-written type guards on unknown values (`typeof x === 'object' && x !== null`,
  ad-hoc `isX(value: unknown)` helpers).
- Validator helpers outside a schema (`validator.isEmail`, custom regex checks
  on raw input).
- A type declared next to its schema instead of inferred from it.

Preconditions on values that are already typed use `invariant`, and
exhaustive switches use `unreachable` (both from `@arki/failure`). Arki
decision A-39 records this principle for every `@arki/*` package.

---

## When the principles conflict

Pick the one earlier in this list. If you have to violate one, document
which one and why — in the code, in a PR description, and (if the violation
becomes permanent) in the next minor-version release notes.

The principles are versioned with `@arki/dot` itself. Changes to this list
are documented in [release-policy.md](./release-policy.md).
