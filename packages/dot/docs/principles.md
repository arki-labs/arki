# Design principles

DOT is built around five principles. They are the standard every API,
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

**Playful** does *not* mean cute, ironic, or whimsical for its own sake.
It means *human*. A real developer wrote this. They cared. They had taste.

**Precise** means every word is the *right* word. `pip` not "module." `boot`
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
- **Refuse buzzwords** ("seamless," "best-in-class," "enterprise-grade,"
  "next-generation"). They mean nothing.
- **Refuse hedging language** in core docs ("you might want to…",
  "consider…", "feel free to…"). DOT has opinions; state them.

What this principle *forbids*:

- Generic, committee-shaped naming (`Plugin`, `Manager`, `Provider`,
  `Helper`, `Util`).
- Apology-shaped error messages ("Sorry, something went wrong").
- Filler that makes prose longer without making it clearer.

---

## 2. Pips ARE the app — no hidden core

There is no framework "underneath" the pips. Remove every pip and you
remove the app. The kernel composes pips; it does not contain the app's
behavior.

This means we:

- Never add **framework-reserved service kinds** that "always work" without
  a pip publishing them. If you want `services.logger`, a pip publishes it.
- Never add **hidden lifecycle hooks** that run outside the 5-hook
  sequence (`configure → boot → start → stop → dispose`).
- Never put **app behavior in defaults**. Defaults can shape *config*; they
  cannot shape *what the app does*.

What this principle *forbids*:

- A global "DOT context" that pips read from without declaring it.
- "Built-in" services that bypass the registration protocol.
- Magic auto-loading of pips from the filesystem.

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

What this principle *forbids*:

- "Eventual consistency" between pips during boot.
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
  **stable error code** (e.g. `DOT_LIFECYCLE_E003`). Codes are part of the
  public API.
- Every error has a **`remediation` string** that tells you what to do, and
  a **`docsUrl` string** that points at the page that explains it.
- Every public type is **importable** — no hidden shapes that an agent
  would need to reverse-engineer from runtime output.

What this principle *forbids*:

- `throw new Error('...')` with no code.
- "See the docs" without a URL.
- Log-scraping as a test assertion. Tests assert on the envelope.

---

## 5. The kernel has zero optional dependencies

`@arki/dot` ships with `@arki/assert`, `@arki/contracts`, `@arki/log`,
and `zod`. That is the entire dependency surface. Adapters (database,
queue, auth, event-sourcing) live in their own packages and depend on
`@arki/dot` as an *optional peer*.

This means we:

- **Never bundle adapter code into the kernel.** A user who only needs
  pipe composition pays for nothing else.
- **Adapters break in isolation.** If `@arki/db` has a bug, an app using
  only `@arki/kv` is unaffected.
- **Each adapter declares `@arki/dot` as `peerDependencies` with
  `peerDependenciesMeta.optional: true`.** The adapter only loads when both
  packages are installed.

What this principle *forbids*:

- "Bring-your-own-everything" config in the kernel that pretends to be
  optional but ships as part of the package.
- Cross-adapter deps (e.g., `@arki/db` requiring `@arki/kv`). Adapters are
  composed at the *app* layer, not chained in source.

---

## When the principles conflict

Pick the one earlier in this list. If you have to violate one, document
which one and why — in the code, in a PR description, and (if the violation
becomes permanent) in the next minor-version release notes.

The principles are versioned with `@arki/dot` itself. Changes to this list
are documented in [release-policy.md](./release-policy.md).
