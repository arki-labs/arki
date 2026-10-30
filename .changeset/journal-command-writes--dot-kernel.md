---
'@arki/dot': patch
---

A command declares the events it writes. Breaking (0.x, no shims):

- `j.command(name, input, options, handler)` replaces `j.command(name, input, handler, options?)`. `options.writes` is required: `{ writes: [OrderPaid] }`, or `{ writes: [] }` for a command that only runs child commands. `authorize` moves into the same object.
- `write` in a handler takes only the declared events: anything else is a type error. At run time an undeclared event fails the run with `BAD_DEFINITION`, naming the command and the event, and nothing commits, even when the handler catches the error.
- `Command` has a fifth type parameter, `Writes`, and a read-only `writes` field that keeps the exact tuple, so code can read it before boot. `CommandContext` has a third, `Declared`. `CommandOptions` has a fifth.
- New type `CommandWrite<MetaOut, Tx, Declared>`, the type of `context.write`. A helper that takes `write` names what it writes; a command can pass its `write` only when it declares at least those events.

`@arki/payments` moves its commands to the new form; its API does not change. The `@arki/dot` app-stack template and the `@arki/db` README show the new form.

See `docs/upgrades/0.3.0-to-0.4.0.md`, step 12.

docs: README (Quick start, Commands, Idempotent commands, Failures, Workflows, Dot), `docs/agent-guide.md` (model, write a command, rules that bite, errors, shared packages), `llms.txt`.
demo impact: `demos/faultline` (commands and lesson 02) moves to the new form.
