# ARKI

TypeScript-first toolkit for building agent-native applications.

ARKI is a family of small, focused packages under the `@arki/*` scope on npm,
tied together by **DOT** — the `@arki/dot` framework whose apps are composed
of **pips**: small, lifecycle-aware units that each publish typed services and
compose deterministically. See [`packages/dot/README.md`](packages/dot/README.md)
for the "what is a pip?" primer.

## Quick start

```bash
bunx @arki/dot new my-app
cd my-app
bun install
bun run dev
```

See [`packages/dot/README.md`](packages/dot/README.md) for the full DOT
reference and [`packages/`](packages/) for the rest of the toolkit.

## Packages

Every package in this repo is published independently to npm under the
`@arki/*` scope. See each package directory for its own README.

| Wave | Theme |
| ---- | ----- |
| Foundation | `@arki/assert`, `@arki/contracts`, `@arki/log`, `@arki/env`, `@arki/ts`, `@arki/resilience`, `@arki/date`, `@arki/string`, `@arki/slugify`, `@arki/clock` |
| DOT kernel | `@arki/dot` |
| Adapters | `@arki/db`, `@arki/kv`, `@arki/fs`, `@arki/queue`, `@arki/event-sourcing`, `@arki/auth`, `@arki/emails` |
| Frontend | `@arki/design-systems`, `@arki/theme`, `@arki/icons`, `@arki/react-hooks`, `@arki/ui` |
| Specialized | `@arki/ai`, `@arki/rich-text`, `@arki/images`, `@arki/diff-engine` |

## License

MIT. See [`LICENSE`](LICENSE).

## Contributing

This repository is the **generated public mirror** of the ARKI workspace.
Sources are not edited here directly — open issues and discussion threads
instead, and we will land the change upstream and re-export.
