---
'@arki/journal': minor
---

`@arki/journal/foreman` names no Zod in its types. Breaking:

- `journalJobsModule` and `journalWorkflowsModule` return a plain `ForemanModule` from `@arki/admin`. The admin dispatcher reads their schemas at runtime, so registering them is unchanged; a read called on the returned object directly returns `unknown`.
- The summary schemas `AttemptSummary`, `OperationSummary`, `ArchivedSummary` and `JobSummary` are no longer exported. Their types keep their names, written in TypeScript and locked to the internal schemas by a type test.

See `docs/upgrades/0.3.0-to-0.4.0.md`, step 10.
