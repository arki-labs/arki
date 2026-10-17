AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/mail

## Laws

1. A send that was not delivered for an expected reason is a returned failure, never a throw. Throw `MailError` only for misuse: bad config, a bad message, a field the transport cannot carry.
2. After a timeout, a network failure or an unreadable answer, return `MailUncertain`. The service may have taken the mail. Never report it as sent and never as surely failed.
3. Never try a second provider after `MailUncertain`. Only a retryable `MailRejected` moves `failover` on. A second send could deliver a duplicate.
4. A message id is the provider's or `null`. Never make one up.
5. Every transport maps a provider's answer with `src/transport-failures.ts`. Do not invent a mapping in a transport.
6. A transport refuses a field it cannot carry with `ARKI_MAIL_E005` before any request.
7. Header injection is checked in `src/message.ts`. Every address and header value goes through it.
8. `text` is required on every template. `html` is optional.
9. A queued mail goes through `mailOutbox.enqueue` inside the caller's transaction, with exactly one `to` recipient. Never enqueue on the root database (`E009`).
10. Quota counts are advisory. A failing counter is logged and never fails a send.
11. Keys and secrets never appear in the manifest or in logs. In Dot, pass `mail(() => options)`.

## Changing this package

- New transport: `src/http/<name>.ts` or `src/node/<name>.ts`. Add the export to `package.json`, then run `transportContract` from `@arki/mail/testing` against it.
- New failure: `src/failures.ts`, with JSDoc `@fix` and `@verify`. Update the README Failure behaviour table and the guide's Errors section.
- New error code: `src/errors.ts` with JSDoc `@fix` and `@verify`.
- Run `bun ../../tooling/library/src/llms.ts --write` after an export change.
- Keep `README.md`, `llms.txt` and `docs/agent-guide.md` in step.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
