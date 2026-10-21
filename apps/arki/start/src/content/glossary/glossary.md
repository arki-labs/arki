---
source: docs/arki/glossary.md
---

# Glossary

The words ARKI docs use, one plain sentence each. The "formerly" column lists old
names that still appear in older pages, so you can match them to the current word.

| Term | What it means | Where to read | Formerly |
|---|---|---|---|
| plugin | A unit of an app that needs some services and provides others, and has five hooks: `configure`, `boot`, `start`, `stop`, `dispose`. | [Plugin authoring](../../packages/dot/docs/plugin-authoring.md) | Pip |
| app | The list of plugins you build with `defineApp(name).use(a).use(b)`; the order of `.use()` is the boot order. | [Quickstart](../../packages/dot/docs/quickstart.md) | `createDot(...)` (a compatibility alias only) |
| feature | One chain made with `defineFeature(name)` from `@arki/dot/feature` that holds a slice of your product: its needs, infra, usecases and entrypoints. | [Agent guide](../../packages/dot/docs/agent-guide.md) | |
| usecase | A function inside a feature that does one thing your product does. | [Agent guide](../../packages/dot/docs/agent-guide.md) | |
| action | A named operation an app exposes, listed in the manifest. | [Diagnostics](../../packages/dot/docs/diagnostics.md) | |
| adapter | A `/dot` entry of a package (for example `@arki/db/dot`) that wraps the package as a plugin; `@arki/dot` never imports adapters. | [Adapter authoring](../../packages/dot/docs/adapter-authoring.md) | |
| handle | A typed key a plugin uses to ask for a service or to provide one. | [Plugin authoring](../../packages/dot/docs/plugin-authoring.md) | |
| service witness | A `service<T>()` marker that tells the compiler which type a service has, without a value at runtime. | [Plugin authoring](../../packages/dot/docs/plugin-authoring.md) | |
| wire key | The name under which a plugin provides a service; two providers of one key collide. | [Agent guide](../../packages/dot/docs/agent-guide.md) | |
| manifest | The static graph of an app (plugins, services, actions, dependencies, lifecycle); `dot explain --json` prints it. | [Diagnostics](../../packages/dot/docs/diagnostics.md) | |
| diagnostic | A snapshot of a running app (per-plugin status, lifecycle, issues), each issue with a stable `code` and a `remediation`; `dot doctor --json` prints it. | [Diagnostics](../../packages/dot/docs/diagnostics.md) | |
| app graph | The picture of which plugins need which services; the manifest holds it. | [Agent guide](../../packages/dot/docs/agent-guide.md) | |
| boot check | A run of `dot doctor`: it calls `configure()`, then `boot()`, reads the diagnostics, then `dispose()`, and never calls `start()`. | [Agent guide](../../packages/dot/docs/agent-guide.md) | |
| failure | An expected outcome returned as a value (made with `defineFailure`), not thrown; bugs and bad config still throw. | [`@arki/failure`](../../packages/failure/README.md) | |
| tier | A group of packages by role: Tier 1 is the app stack, Tier 2 is the standalone libraries. | [Core packages](core-packages.md) | |
| leaf library | A Tier 2 package that depends on no other ARKI package at runtime, so it works on its own. | [Core packages](core-packages.md) | |
| source-distributed | A package that ships TypeScript or CSS source, not a built bundle, because the app's bundler builds it. | [Release policy](../../packages/dot/docs/release-policy.md) | |
| wave | A set of packages published together, in an order where dependencies come first. | [Release skill](../../.agents/skills/arki-release/SKILL.md) | |
| candidate | The frozen set of tarballs for a wave; the bytes checked are the bytes published. | [Release skill](../../.agents/skills/arki-release/SKILL.md) | |
| mirror | A read-only GitHub repository (`arki-labs/<name>`) that holds one published package version; source and issues live at `arki-labs/arki`. | [CONTRIBUTING](../../CONTRIBUTING.md) | |
| X-ray | A screen in a demo app that shows what the app really did, such as each action and the AI provider and cost of each call. | [Now-tier plan](../plans/2026-10-17-arki-now-tier.md) | |
