---
'@arki/dot': minor
---

`dot` now runs on `@arki/cli`. Breaking for scripts and agents that read its output:

- Output is the `arki.cli/1` envelope: `{ ok, command, data, error, meta }`. It is JSON by default when stdout is piped; `--json` or `-o json` forces it, `-o text` forces text.
- Exit codes: `0` ok, `1` bug, `2` usage (`cli.unknown_command`, `cli.invalid_input`), `3` a returned failure.
- `dot.*` failure codes replace `DOT_CLI_E001`–`E011`: `dot.app_not_found`, `dot.app_invalid_export`, `dot.app_import_failed`, `dot.app_lifecycle_failed`, `dot.observability_no_sdk`, `dot.projection_not_found`, `dot.projection_import_failed`, `dot.projection_execution_failed`, `dot.projection_conflict`, and new `dot.doctor_failed`, `dot.target_not_empty`, `dot.template_missing`, `dot.write_failed`. `E004`/`E005` are the framework's `cli.unknown_command` / `cli.invalid_input`.
- `dot doctor` returns the snapshot plus `.data.status` (`success` or `warning`); error issues return `dot.doctor_failed` (exit 3) with the report in `.error.data`.
- `dot new` returns `.data.app`, `.data.operations[]` and `.data.nextSteps`.
- `--openapi` is removed; use `--as openapi`.
- Removed exports: `DotCliError`, `DotCliErrorCode`, `dotCliDocsUrl`, `DotCliEnvelope`, `DotCliEnvelopeStatus`, `DotNewEnvelope`, `main`, `parseArgs`. `runExplain`, `runDoctor` and `runNew` return their data or a failure and print nothing; `program` is the CLI.
