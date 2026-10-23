/** The "What's inside" inventory: six sheets of things arki and Dot do, each row with the code that shows it. Types are inferred from this value. */
export const insideGroups = [
  {
    id: 'dot',
    sheet: 'I-101',
    title: 'Dot: the app kernel',
    intro: 'Dot composes an app from typed units, and the compiler checks the wiring before anything runs.',
    rows: [
      {
        feature: 'Provider order checked by the compiler',
        what: 'Mount a unit before the one it needs, or the editor rejects that line and the error says where to move it.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/src/define-app.ts',
          lines: '93-98',
          code: "type NeedsError<TAvail extends ServiceRecord, TNeeds extends ServiceRecord> = {\n  readonly 'DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.infra \u2192 .features \u2192 .entrypoints)': {\n    readonly missing: MissingKeys<TAvail, TNeeds>;\n    readonly mismatched: MismatchedKeys<TAvail, TNeeds>;\n  };\n};",
          imports: [
            {
              lines: '42-56',
              code: "import type {\n  AnyUnit,\n  EmptyPhases,\n  EmptyShape,\n  MergePhases,\n  RuntimeUnit,\n  ServiceRecord,\n  UnitCloseFailure,\n  UnitOpenFailure,\n  UnitPhaseFailures,\n  UnitPhases,\n  UnitRole,\n  UnitSourceGuard,\n  UnitWiring,\n} from './unit-contract.js';",
            },
          ],
        },
      },
      {
        feature: 'Key collisions caught at compile time',
        what: 'Two units that provide the same key do not type-check; rename() gives one of them a new key and rebuilds its handles.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/src/define-app.ts',
          lines: '100-103',
          code: "type CollisionError<TAvail, TProvides> = {\n  readonly 'DOT: this unit provides a key that an earlier unit already provides. Give one of them a new key with rename()': keyof TAvail &\n    keyof TProvides;\n};",
        },
      },
      {
        feature: 'Typed service handles',
        what: 'A unit names what it needs as handles like database.provides.db; the type comes from the provider, and .lazy defers the value until first use.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/docs/di.md',
          lines: '646-649',
          code: '  .needs({\n    db: database.provides.db, // typed from the provider\n    cache: cache.provides.kv.lazy, // a Lazy<T>, even if the provider is eager\n  })',
        },
      },
      {
        feature: 'entrypointOnly: infra the usecases never see',
        what: 'A feature can take db or kv for its own store and limiter while its usecases only pick the services they name.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'apps/avocabo/backend/src/features/waitlist/feature.ts',
          lines: '34-39',
          code: "  .needs({\n    db: entrypointOnly(database.provides.db),\n    kv: entrypointOnly(cache.provides.kv),\n    // The app's outbound email client; a test fakes the plugin.\n    mailer: emailClient.provides.emailClient,\n  })",
          imports: [
            { lines: '12', code: "import { defineFeature, entrypointOnly } from '@arki/dot/feature';" },
            {
              lines: '17-19',
              code: "import { database } from '../../infra/db';\nimport { cache } from '../../infra/kv';\nimport { emailClient } from '../../infra/mail/client';",
            },
          ],
        },
      },
      {
        feature: 'Stable error codes',
        what: 'Every kernel failure has an ARKI_DOT_E### code that is never renumbered or reused, so a link to its page stays valid.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/src/lifecycle.ts',
          lines: '50-55',
          code: ' * Stable error codes for every failure the kernel throws, `ARKI_DOT_E001`..\n * Codes are never renumbered and never reused (E009 and E010 are retired).\n * E001-E021 and E033 are lifecycle failures; E022-E031 are feature-composition\n * failures (see `FEATURE_ERROR_CODES`); E032 is non-JSON manifest data.\n */\nexport const DotLifecycleErrorCode = {',
        },
      },
      {
        feature: 'Wrong order caught at configure, before boot',
        what: 'A provider mounted after its consumer fails as ARKI_DOT_E020 while the app is still being configured; no connection has opened yet.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/docs/diagnostics.md',
          lines: '218-220',
          code: 'at `configure()`:\n\n- `ARKI_DOT_E020` — a provider is mounted after its consumer. The fix',
        },
      },
      {
        feature: 'boot() returns a failure, never throws',
        what: 'A failed boot comes back as a typed value; the units already booted are disposed in reverse order and the app is marked failed.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/docs/lifecycle.md',
          lines: '100-102',
          code: '- Previously booted units dispose in reverse declaration order.\n- App transitions to `failed`; no failed provider publishes a service.\n- The original refusal is returned when cleanup succeeds; unknown throws become',
        },
      },
      {
        feature: 'dot explain and dot doctor',
        what: 'explain prints the app manifest from configure alone; doctor boots the app, runs its checks and disposes it; both answer in JSON.',
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/dot/docs/cli.md',
          lines: '9-10',
          code: '| `dot explain` | Imports the app file and runs `configure`. Never boots.                                    |\n| `dot doctor`  | Boots the app (`boot` hooks run, migrations apply), then disposes it. Never calls `start`. |',
        },
      },
      {
        feature: 'OTel-first kernel',
        what: 'Traces, metrics and logs come out of the kernel; you wire only the exporter, and without an SDK the no-op API is used.',
        short: 'dot',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/dot/docs/observability.md',
          lines: '3-4',
          code: 'DOT is OTel-first. Traces, metrics, and logs come out of the kernel\nwithout you wiring anything — you wire the _exporter_. Without an OTel SDK, tracing and metrics safely use the API’s no-op implementations.',
        },
      },
      {
        feature: 'TanStack Start as the driving adapter',
        what: "Every Start request gets a typed context: the session, an RPC client and the mounts, built from the app's own services.",
        short: 'dot',
        state: 'shipped',
        new: true,
        proof: {
          path: 'apps/avocabo/backend/src/app.ts',
          lines: '42-47',
          code: '  .entrypoints(\n    hostClock,\n    tanstackStart({\n      needs: { rpc: gateway.provides.rpc, auth: authn.provides.auth, scheduler },\n      session: ({ auth }, request) => auth.principal(request.headers),\n      rpc: ({ rpc }, request) => rpc.client(request.headers),',
          imports: [
            { lines: '18', code: "import { tanstackStart } from '@arki/tanstack-start/dot';" },
            { lines: '23', code: "import { gateway } from './entrypoints/gateway';" },
            { lines: '26', code: "import { authn } from './infra/auth';" },
          ],
        },
      },
    ],
  },
  {
    id: 'journal',
    sheet: 'I-102',
    title: 'Journal: the write path',
    intro: 'Every change is one immutable event next to a normal row, and both are written in one transaction.',
    rows: [
      {
        feature: 'One transaction for row, events, projections and jobs',
        what: 'A write appends the events, saves the row, runs the inline projections and queues the after-commit jobs, and all of it commits or rolls back together.',
        short: 'journal',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/journal/src/write.ts',
          lines: '377-381',
          code: '        for (const event of recorded) {\n          for (const projection of projections) {\n            if (projection.types.has(event.type) && projection.entities.some(e => e.kind === entity.kind)) {\n              await projection.run(sp, event);\n            }',
        },
      },
      {
        feature: 'Commands refuse with typed failures',
        what: 'A rule that says no returns a failure; the write rolls back and run returns it with its type, so every caller must handle it.',
        short: 'journal',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/journal/README.md',
          lines: '85-90',
          code: "    write(order, input.orderId, row => {\n      if (!row) return CommandNotFound({ detail: 'Order not found' });\n      if (row.status !== 'placed') return CommandConflict({ detail: `Order is already ${row.status}` });\n      return [OrderPaid({ amount: input.amount })]; // [] means: write nothing\n    }),\n);",
          imports: [
            {
              lines: '46',
              code: "import { CommandConflict, CommandNotFound, initJournal, need } from '@arki/journal';",
            },
          ],
        },
      },
      {
        feature: 'Reducers patch the row; null deletes it',
        what: 'An entity maps each event to the columns that change; returning null removes the row while its events stay in the log.',
        short: 'journal',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/journal/README.md',
          lines: '75-77',
          code: "  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))\n  .on(OrderPaid, () => ({ status: 'paid' })) // a patch: only the columns that change\n  .on(OrderCancelled, () => null); // null deletes the row; the events stay",
        },
      },
      {
        feature: 'Idempotent commands and HTTP replies, one receipts table',
        what: 'journal_receipts answers a retried command with its first result, and the same table caches a whole HTTP response for the idempotent() middleware.',
        short: 'journal',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/journal/README.md',
          lines: '191-194',
          code: "import { idempotent } from '@arki/http/idempotency';\nimport { responseCache } from '@arki/journal/http';\n\nidempotent({ cache: responseCache(db, tables), scope, routes: ['POST /orders'], ttl: 86_400_000 });",
        },
      },
      {
        feature: 'Effects after commit, at least once',
        what: 'An effect runs from a job row once the transaction committed; its jobId stays the same across retries, so you pass it on as an idempotency key.',
        short: 'journal',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/journal/README.md',
          lines: '409',
          code: 'An effect runs after the commit, at least once, from a row in `journal_jobs`. A handler gets the event and a context: `(e, { jobId, signal, db, run })`.',
        },
      },
      {
        feature: 'Wake channel on commit',
        what: 'Each commit that recorded events calls pg_notify with the seq range, so every listening worker in every process drains at once.',
        short: 'journal',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/journal/src/write.ts',
          lines: '410',
          code: '          sql`select pg_notify(${deps.wakeChannel}, ${JSON.stringify({ from: Math.min(...seqs), to: Math.max(...seqs) })})`,',
          imports: [{ lines: '7', code: "import { and, eq, sql } from 'drizzle-orm';" }],
        },
      },
      {
        feature: 'Durable workflows are journal entities',
        what: 'A workflow run is an entity; every step, wait and undo is an event in journal_events, and each step runs as a job that survives a restart.',
        short: 'journal',
        state: 'candidate',
        changeset: '.changeset/journal-workflows.md',
        new: true,
        proof: {
          path: 'packages/journal/README.md',
          lines: '810',
          code: 'A workflow is a list of steps that runs to the end even when the process dies. Each step runs as a job in `journal_jobs`. When a step finishes, its result is saved (a checkpoint) and the next step is scheduled, in one transaction. A run can wait for a signal from outside, or sleep, for hours or days. When it cannot finish, it undoes the steps it did, newest first (compensation). The run is a journal entity (`workflow.run`), so every move is an event in `journal_events`.',
        },
      },
      {
        feature: 'A workflow starts from a domain event',
        what: 'startOn ties a run to an entity event; the run id and its input come from that event, in the transaction that recorded it.',
        short: 'journal',
        state: 'candidate',
        changeset: '.changeset/journal-workflows.md',
        new: true,
        proof: {
          path: 'packages/payments/src/refunds/workflow.ts',
          lines: '124-129',
          code: '        startOn: {\n          entity: refund,\n          event: refundsJournal.events.RefundApproved,\n          id: e => refundRunId(e.entityId),\n          input: e => ({ refundId: e.entityId }),\n        },',
        },
      },
      {
        feature: 'Steps carry an idempotency key',
        what: 'A step gets a key that is the same on every try, so a provider answers a repeat with the first result instead of acting twice.',
        short: 'journal',
        state: 'candidate',
        changeset: '.changeset/journal-workflows.md',
        new: false,
        proof: {
          path: 'packages/payments/src/refunds/workflow.ts',
          lines: '173-177',
          code: '            (await provider.refundPayment(paymentId, {\n              refundId: input.refundId,\n              // The same on every try of this step: Stripe answers a repeat with the first refund\n              idempotencyKey: key,\n              amount: fromMinorColumn(amountMinor, currency),',
          imports: [{ lines: '38', code: "import { fromMinorColumn } from '../core/money.js';" }],
        },
      },
      {
        feature: 'waitFor a signal, with a timeout',
        what: 'A run can wait days for an outside signal, check it against a schema, and carry on or stop when the time runs out.',
        short: 'journal',
        state: 'candidate',
        changeset: '.changeset/journal-workflows.md',
        new: true,
        proof: {
          path: 'packages/payments/src/refunds/workflow.ts',
          lines: '201-206',
          code: "      .waitFor('settled', {\n        signal: 'stripe.refund.settled',\n        schema: settledSchema,\n        timeout: '3d',\n        // No signal in 3 days: `record` asks Stripe\n        onTimeout: 'continue',",
        },
      },
      {
        feature: 'Erasure that keeps history consistent',
        what: "forget rewrites an entity's events to their erased form and repairs the row from the rewritten log, in one transaction.",
        short: 'journal',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/journal/README.md',
          lines: '262',
          code: '`journal.forget(db, entity, id)` rewrites every stored event of that entity that has an erased form to it, sets `erased_at` on those rows, and then repairs the row from the rewritten log, so the row and its history agree. All in one transaction. An erased form the schema rejects is `BAD_DEFINITION` and nothing changes. A history replay cannot rebuild, such as a legacy row that was never adopted, is `NO_HISTORY` and nothing changes: adopt it first. Running it twice is safe; the first erased time is kept. It returns `{ erased, row }`.',
        },
      },
      {
        feature: 'The journal as a Dot plugin',
        what: 'Add the journal to a Dot app with two plugins: journal() gives features a services.journal to write through, and journalWorker() runs the effects, taps and async projections, handing each the services of the feature that lists it.',
        short: 'journal',
        state: 'shipped',
        new: true,
        note: 'No app uses it yet.',
        proof: {
          path: 'packages/journal/src/dot.ts',
          lines: '612-617',
          code: ' * The entrypoint, for `.entrypoints()`: one worker between `start` and `stop`, for the\n * journal that `journal(...)` published. Each effect and tap of a feature gets the\n * services of that feature. A process that serves no worker still writes: its jobs\n * wait for a process that does. With `jobs`, the worker also runs queue rows\n * (`@arki/queue/outbox`) through the runner the source builds at boot.\n */',
        },
      },
    ],
  },
  {
    id: 'data',
    sheet: 'I-103',
    title: 'Data',
    intro: 'Postgres through Drizzle, a key-value store with a fallback, and config that carries its types.',
    rows: [
      {
        feature: 'Three ways to run Postgres',
        what: "node-postgres by default, Bun's native SQL through the bun export condition, or embedded PGlite for local and test runs.",
        short: 'db',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/db/README.md',
          lines: '5',
          code: '- Two runtime entry points (`node-postgres` pool by default, Bun-native SQL via the `bun` export condition, embedded PGlite via `./runtime-local`).',
        },
      },
      {
        feature: 'Key-value with a safe fallback',
        what: 'Keyv underneath, Redis rate limiting, TLS from rediss:// URLs, and an in-memory fallback when Redis is unreachable.',
        short: 'kv',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/kv/README.md',
          lines: '3',
          code: 'Key-value store abstraction with pluggable adapters for ARKI. Wraps [Keyv](https://keyv.org/) for general key-value access and [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) for Redis-backed rate limiting. Provides automatic TLS handling (via `rediss://` URLs), Upstash support, and a graceful in-memory fallback when Redis is unreachable.',
        },
      },
      {
        feature: 'Encrypted env files you can commit',
        what: 'Secrets live encrypted in .env.<environment> files; a public key in the file lets anyone add a value, and only the private key reads them.',
        short: 'env',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/env/README.md',
          lines: '85',
          code: 'Commit `.env.<environment>` files with their secrets encrypted. The format is dotenvx 2.x, so the `dotenvx` CLI reads the same files. Each file holds a public key, so anyone can add a value. Only a holder of the private key can read one. The private key lives in `DOTENV_PRIVATE_KEY_<ENV>` (for `.env.production`: `DOTENV_PRIVATE_KEY_PRODUCTION`) or in the gitignored `.env.keys` file.',
        },
      },
      {
        feature: 'Typed env with any Standard Schema',
        what: 'defineEnv validates on the first read and returns a typed object; Zod, Valibot, ArkType or a hand-written schema all work.',
        short: 'env',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/env/README.md',
          lines: '3',
          code: 'Type-safe environment variables for ARKI. `defineEnv()` wraps [`@t3-oss/env-core`](https://env.t3.gg/). It validates on the first read and returns a typed object. Any [Standard Schema](https://standardschema.dev) works: Zod, Valibot, ArkType or a hand-written `~standard` object.',
        },
      },
    ],
  },
  {
    id: 'web',
    sheet: 'I-104',
    title: 'Web and UI',
    intro: 'Typed HTTP you can test without a socket, and components built on one token vocabulary.',
    rows: [
      {
        feature: 'Route contracts as data, OpenAPI from them',
        what: 'A route is a value; handlers are validated by any Standard Schema, and the OpenAPI document is generated the same way every time.',
        short: 'http',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/http/README.md',
          lines: '3-6',
          code: 'Typed HTTP for ARKI — route contracts as data, handlers validated by any\nStandard Schema (zod, valibot, arktype, your own),\nrequest-scope derivers, SSE streaming, and deterministic OpenAPI\ngeneration. Ships a DOT adapter (`@arki/http/dot`) whose `http()` entrypoint unit',
        },
      },
      {
        feature: 'An engine you can call without a socket',
        what: 'buildEngine returns a fetch function; a test passes a Request and reads the Response, and no server is started.',
        short: 'http',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/http/README.md',
          lines: '39-41',
          code: "const engine = buildEngine([routes().bind(getOrder, ({ params }) => ({ id: params.id, total: 12 }))]);\n\nconst response = await engine.fetch(new Request('http://localhost/orders/ord_1'));",
          imports: [{ lines: '28', code: "import { buildEngine, route, routes } from '@arki/http';" }],
        },
      },
      {
        feature: 'One import per component',
        what: 'Base UI primitives styled with Tailwind v4 semantic tokens: forms, overlays, navigation, data display and charts.',
        short: 'ui',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/ui/README.md',
          lines: '3',
          code: 'React component library for ARKI apps: Base UI primitives styled with Tailwind v4 semantic tokens. Forms, overlays, navigation, data display and charts. One import per component.',
        },
      },
    ],
  },
  {
    id: 'money',
    sheet: 'I-105',
    title: 'Money and payments',
    intro: 'Amounts are whole units, currencies are kept apart by the type, and payments write through the journal.',
    rows: [
      {
        feature: 'Exact units, a number until bigint is needed',
        what: '19.99 EUR is 1999 units; nothing rounds unless you ask, and a plain number is used up to 2^53.',
        short: 'money',
        state: 'shipped',
        new: true,
        proof: {
          path: 'packages/money/README.md',
          lines: '5',
          code: '- **Exact.** Amounts are whole numbers of units: `19.99 EUR` is `1999` units at 2 decimals. Nothing rounds unless you pass a rounding mode.',
        },
      },
      {
        feature: 'Currencies kept apart by the type',
        what: "Money<'EUR'> cannot be added to Money<'USD'>; the compiler stops it, and the runtime throws too.",
        short: 'money',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/money/README.md',
          lines: '7',
          code: "- **Safe types.** `Money<'EUR'>` cannot be added to `Money<'USD'>`. The compiler stops it, and the runtime throws `CurrencyMismatchError` too.",
        },
      },
      {
        feature: 'Stripe provider with journal commands',
        what: 'Plans, customers, subscriptions, payments, refunds, dunning and tax, with table factories, repositories and commands; routers stay in your app.',
        short: 'payments',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/payments/README.md',
          lines: '3',
          code: 'Payments for ARKI apps: a Stripe provider, plans, customers, subscriptions, payments, refunds, dunning and tax. It ships Drizzle table factories, repositories, services and [`@arki/journal`](https://www.npmjs.com/package/@arki/journal) commands. Routers stay in each consuming app, so the app owns its RPC context and its authorization policy.',
        },
      },
    ],
  },
  {
    id: 'platform',
    sheet: 'I-106',
    title: 'Platform',
    intro: 'The small packages every layer stands on: failures, schemas, logs, the command line and time.',
    rows: [
      {
        feature: 'Failures without a wrapper',
        what: 'A function returns the value itself or a failure; there is no ok() to add and no .value to unwrap.',
        short: 'failure',
        state: 'candidate',
        new: true,
        proof: {
          path: 'packages/failure/README.md',
          lines: '28-32',
          code: "const EmailTaken = defineFailure('user.email_taken', {\n  status: 409,\n  data: z.object({ email: z.string() }),\n  message: 'email {email} is taken',\n});",
          imports: [
            { lines: '24', code: "import { z } from 'zod';" },
            { lines: '26', code: "import { defineFailure, isFailure } from '@arki/failure';" },
          ],
        },
      },
      {
        feature: 'The failure union is inferred',
        what: "A function's return type lists every failure it can produce, including the ones it passes on; nobody writes the union down.",
        short: 'failure',
        state: 'candidate',
        new: true,
        proof: {
          path: 'packages/failure/README.md',
          lines: '48',
          code: "`signUp` returns `{ email } | Failure<'user.email_taken', { email: string }>`. Nobody wrote that type. The compiler infers it, and `result.email` is a type error until `isFailure` has run.",
        },
      },
      {
        feature: 'A lint rule catches an ignored failure',
        what: 'must-use reports a call whose failure is thrown away; no-blind-accept reports an accept of a failure not checked by kind.',
        short: 'failure',
        state: 'candidate',
        new: true,
        proof: {
          path: 'packages/failure/README.md',
          lines: '9',
          code: '- **Caught when ignored.** The `must-use` lint rule reports a call whose failure is thrown away. `no-blind-accept` reports `accept(r)` of a failure not checked by kind.',
        },
      },
      {
        feature: 'One execution path for every Standard Schema',
        what: 'Bring Zod, Valibot, ArkType or your own validator; parse returns the output or a canonical failure.',
        short: 'schema',
        state: 'candidate',
        new: false,
        proof: {
          path: 'packages/schema/README.md',
          lines: '3',
          code: 'Standard Schema types, validation execution, issue helpers and a JSON Schema bridge. Bring Zod, Valibot, ArkType or your own validator. Execution is shared with `@arki/failure/schema`; the dependency graph is schema → failure → Standard Schema spec types.',
        },
      },
      {
        feature: 'A JSON envelope when piped, text on a terminal',
        what: 'One defineCommand gives the flags, their coercion and the help from the input schema; a run writes JSON when stdout is a pipe.',
        short: 'cli',
        state: 'candidate',
        new: true,
        proof: {
          path: 'packages/cli/README.md',
          lines: '3',
          code: 'Typed command-line programs from one `defineCommand({...})`. The input schema drives the flags, their coercion and their help. A run writes a JSON envelope when stdout is a pipe and text on a terminal. Exit codes are stable. Help and `--version` never run a command, and import at most one lazy level of the tree.',
        },
      },
      {
        feature: 'Message templates keep values as fields',
        what: "A template like 'user {userId} signed in' logs its fields, a processor can redact one, and records map onto the OpenTelemetry log model.",
        short: 'log',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/log/README.md',
          lines: '3',
          code: 'Zero-dependency structured logging for every JavaScript runtime. Libraries log; apps configure. Message templates keep their values as fields, channels are set in one config, and records map onto the OpenTelemetry log data model. Importing it does nothing: no env read, no output, no listener.',
        },
      },
      {
        feature: 'Temporal dates with no hidden now',
        what: 'Calendar dates, instants, zoned date-times, durations and business days; values are immutable, and there is no hidden zone.',
        short: 'date',
        state: 'shipped',
        new: false,
        proof: {
          path: 'packages/date/README.md',
          lines: '3',
          code: 'Date and time math on [Temporal](https://tc39.es/proposal-temporal/) values with a small, explicit API. Calendar dates, instants, zoned date-times, durations, interval algebra, business days, formatting and relative text. Values are immutable, one arithmetic policy applies everywhere, and there is no hidden "now" and no hidden zone.',
        },
      },
      {
        feature: 'Login and sessions',
        what: 'A first-party auth package is planned for the infrastructure-adapters wave.',
        short: 'auth',
        state: 'planned',
        new: false,
        proof: null,
      },
      {
        feature: 'Email',
        what: 'A first-party mail package is planned for the infrastructure-adapters wave.',
        short: 'mail',
        state: 'planned',
        new: false,
        proof: null,
      },
      {
        feature: 'Live updates',
        what: 'Live queries that publish every commit to a table are planned for the infrastructure-adapters wave.',
        short: 'live',
        state: 'planned',
        new: false,
        proof: null,
      },
    ],
  },
] as const;

type Proof = NonNullable<(typeof insideGroups)[number]['rows'][number]['proof']>;

/** The import lines a proof shows above its code, copied from the top of the same file (or the same code block). */
const proofImports = (proof: Proof) => ('imports' in proof ? proof.imports : []);

/** Every range a proof shows, imports first: `["12", "17-19", "34-39"]`. */
export const proofRanges = (proof: Proof): readonly string[] => [
  ...proofImports(proof).map(part => part.lines),
  proof.lines,
];

/** The text a proof shows: the imports run together, then a blank line, then the code. */
export function proofText(proof: Proof): string {
  const imports = proofImports(proof);
  return imports.length === 0 ? proof.code : `${imports.map(part => part.code).join('\n')}\n\n${proof.code}`;
}
