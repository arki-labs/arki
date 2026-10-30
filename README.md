# Arki

TypeScript libraries for building apps that both people and agents can read.

Arki is a family of small `@arki/*` packages. Use one on its own, like
`@arki/date` or `@arki/money`. Or compose a whole backend with
[`@arki/dot`](packages/dot): typed units for infra, features and entrypoints,
wired by the compiler and booted in declaration order.

Every package follows the same rules:

- **Types are written once.** A type is declared at its source (a schema, a
  table, a builder chain) and inferred everywhere else.
- **Schemas own validation.** Unknown input becomes typed data only through a
  [Standard Schema](https://standardschema.dev) (Zod, Valibot or ArkType).
- **Failures are values.** Expected errors are returned with a stable code,
  not thrown. See [`@arki/failure`](packages/failure).
- **Agents are first-class readers.** Stable error codes, `--json` output on
  every CLI, an `llms.txt` and an agent guide in every package.
- **Proof, not promises.** Tests run on real Postgres and Redis. Packages are
  checked on Node, Bun, Deno and browsers. Benchmarks run against competitors
  with the methods published.

The full list, with the reason behind each rule, is in
[`docs/arki/principles.md`](docs/arki/principles.md).

## Quick start

```sh
bun add @arki/dot @arki/failure
```

```ts
import { defineApp, infra } from '@arki/dot';
import { isFailure } from '@arki/failure';
import { openDb } from './db'; // your own database client

const database = infra({
  name: 'database',
  provides: { db: () => openDb(process.env.DATABASE_URL) },
  async dispose({ db }) {
    await db.close();
  },
});

const app = await defineApp('pizzeria').infra(database).start();
if (isFailure(app)) throw new Error(app.code);
```

Read the [`@arki/dot` README](packages/dot/README.md) for features,
entrypoints and the `dot` CLI.

## Packages

### The stack

| Package | What it does |
| --- | --- |
| [`@arki/dot`](packages/dot) | Compose an app from typed units; the compiler checks the wiring |
| [`@arki/cli`](packages/cli) | Typed CLIs from one `defineCommand`, with a JSON envelope when piped |
| [`@arki/env`](packages/env) | Type-safe environment variables |
| [`@arki/http`](packages/http) | Route contracts as data, schema-validated handlers |
| [`@arki/contracts`](packages/contracts) | Shared schemas and Drizzle contract helpers |
| [`@arki/db`](packages/db) | Drizzle repositories for Postgres and PGlite |
| [`@arki/journal`](packages/journal) | Every entity change as an immutable event row |
| [`@arki/live`](packages/live) | Live queries for oRPC and TanStack Query on your own Postgres |
| [`@arki/kv`](packages/kv) | Key-value store with pluggable adapters |
| [`@arki/lock`](packages/lock) | Distributed locks over memory, Postgres, SQLite, Redis and files |
| [`@arki/queue`](packages/queue) | Typed background jobs on BullMQ, pg-boss or a database row |
| [`@arki/schedule`](packages/schedule) | Typed cron and interval handlers |
| [`@arki/mail`](packages/mail) | Typed mail with schema-checked templates and transport failover |
| [`@arki/auth`](packages/auth) | Sign-in on Postgres or SQLite: one definition, one engine |
| [`@arki/payments`](packages/payments) | Stripe plans, subscriptions, refunds, dunning and tax |
| [`@arki/log`](packages/log) | Zero-dependency structured logging for every runtime |
| [`@arki/failure`](packages/failure) | Typed failures returned as values |
| [`@arki/testing`](packages/testing) | Testcontainers Postgres and Redis, typed factories |
| [`@arki/ui`](packages/ui) | React components on Base UI and Tailwind v4 tokens |
| [`@arki/tanstack-start`](packages/tanstack-start) | TanStack Start wiring for Arki apps |
| [`@arki/ai`](packages/ai) | Local-first AI: generation, embeddings, vector index |
| [`@arki/embeddings`](packages/embeddings) | One embedder shape over many providers |
| [`@arki/chat-ui`](packages/chat-ui) | Chat and agent UI for React |

### Standalone libraries

| Package | What it does |
| --- | --- |
| [`@arki/schema`](packages/schema) | Standard Schema helpers: parse with typed failures |
| [`@arki/date`](packages/date) | Temporal-based dates, instants, durations and intervals |
| [`@arki/string`](packages/string) | Grapheme-aware string toolkit |
| [`@arki/math`](packages/math) | Exact Decimal and Rational arithmetic on bigint |
| [`@arki/money`](packages/money) | Exact, fast money for every runtime |
| [`@arki/expr`](packages/expr) | A safe expression language with a typed AST |
| [`@arki/cas`](packages/cas) | A bounded computer algebra system on `@arki/expr` |
| [`@arki/async`](packages/async) | Abortable sleep, debounce, throttle and concurrency helpers |
| [`@arki/clock`](packages/clock) | A clock you can control in tests |
| [`@arki/resilience`](packages/resilience) | Retry, circuit breaker, timeout and bulkhead |
| [`@arki/ts`](packages/ts) | TypeScript utility types |
| [`@arki/icons`](packages/icons) | Iconify, Phosphor and flag icon sets behind one React entry |
| [`@arki/bench`](packages/bench) | Publishable benchmarks against competitors |

Packages marked `"private": true` in their `package.json` are still in
development and are not published yet.

## Status

Every package is below `1.0`. While a package is `0.x`, a breaking change
ships as a **minor** release and a fix as a **patch**. Read a package's
`CHANGELOG.md` before you upgrade.

## Develop

You need [Bun](https://bun.sh) (version in `package.json`) and Node 26.
Docker is needed for tests that start Postgres or Redis.

```sh
bun install
bun run build       # build every package
bun run typecheck
bun run test
bun run lint
```

Work on one package with a Turbo filter:

```sh
bun run turbo run test --filter=@arki/date
```

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

[MIT](LICENSE)
