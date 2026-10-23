# Newcomer test

Can a developer who has never seen arki install it, change an app, debug a failure and upgrade it using only public materials? This test finds where they stop. Every stop is a docs or product issue.

We want the stranger to get lost, then write down where. Every stop is a docs or product bug.

Plan task: T4.14 in [`docs/plans/2026-10-17-arki-now-tier.md`](../plans/2026-10-17-arki-now-tier.md). Demo standard: [`demos.md`](demos.md).

## Public materials only

The tester may use:

- the site (`arki.dev`: `/docs`, `/packages`, `/errors`, `/llms.txt`);
- npm package pages and READMEs;
- the read-only mirrors on `github.com/arki-labs/*`, including the demos.

The tester may not use the monorepo, private chats or founder knowledge. If the founder helps, record the help as a stop.

## Tasks

Run them in order. Give each task 30 minutes. Stop the clock while the tester waits for installs.

| # | Task | Done when |
| --- | --- | --- |
| 1 | **Install.** Create an app with `dot new`, start it and open it in a browser. | The app answers on its port. `dot doctor --json` exits 0. |
| 2 | **Change.** Add a feature with one stored record and one API call, and show the record on a page. | The record survives a restart. |
| 3 | **Debug.** Be a gremlin: break the dependency order on purpose (the mistake in the Dot quick start), read the `DOT_*` error and fix it from `/errors`. | The tester names the error code and fixes it without help. |
| 4 | **Upgrade.** Move the app to the next published `@arki/dot` minor with the upgrade guide. | Typecheck and start pass on the new version. |

## What to record per stop

One row per stop in `.release/demo-issues/newcomer.json`, the same issue shape that `bun release:arki demo issues` uses:

```json
{ "title": "…", "body": "Task 3, minute 12: …\nExpected: …\nFound: …\nPage: …", "labels": ["found-by:newcomer", "package:@arki/dot"] }
```

A stop is any of:

- a step the tester could not finish;
- a page that sent them to the wrong place;
- an error message without a fix;
- help from the founder.

Also record the minutes per task and the total.

## Agent run

Three fresh agents run the four tasks, one after another. Each agent gets only the public URLs above, a shell in an empty folder, and no repo access. Give each agent this instruction: "If you are stuck for 5 minutes, write the stop and move on." Each agent's stops go into `newcomer.json` with `found-by:newcomer-agent`.

The agent run needs the site and at least one release on npm. Until then it cannot run, and the runs record nothing.

## Human run (founder, F-7)

Recruit 3–5 developers who know TypeScript but not arki. Run the same four tasks on a call, screen shared, without helping. Write each stop as above with `found-by:newcomer-human`.

## After a run

1. Turn the stops into issues on `arki-labs/arki`. `demo issues --apply` files only rows from a registered demo's `lib-gaps.md`, so the founder files newcomer rows with `gh issue create`.
2. Fix the docs for every stop that two or more testers hit.
3. Re-run after the next release. Compare the minutes per task.
