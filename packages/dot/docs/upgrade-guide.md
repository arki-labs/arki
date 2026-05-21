# Upgrade Guide

`@arki/dot` v0.1 is the first public release. The pre-0.1 legacy surface
(`createDot`, `definePip`, the `@arki/dot/legacy/*` barrel,
`@arki/dot/event-sourcing`, and `@arki/dot/presets/runtime-local`) is **not
shipped** in v0.1. Use `defineApp` / `defineDotPip` for composition and
import event-sourcing helpers directly from `@arki/event-sourcing` (the
`eventSourcingFeatures` namespace and `createSimpleProcessManager` live
there now).

Future breaking changes will be documented here, version by version, with:

- A summary of what changed and why.
- Concrete before/after code.
- A codemod where automation is possible.
- A pointer to the relevant `CHANGELOG.md` entries.

## Conventions used in this guide (once entries exist)

Each version section will follow this template:

```markdown
## 1.0.0

### Breaking changes

- **`<symbol or contract>`** — what changed.
  - Before: `<old code>`
  - After: `<new code>`
  - Migration: `<step-by-step or codemod command>`

### Deprecations removed

- `<symbol>` — was deprecated in `0.x`; replacement: `<symbol>`.

### Non-breaking additions (informational)

- `<symbol>` — new in this release.
```

## See also

- [Release policy](./release-policy.md) — SemVer rules and deprecation
  cycle.
