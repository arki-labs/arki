---
'@arki/bench': minor
---

Breaking: `parseSize` now returns `{ bytes }` or `{ problem }` (the part that did not parse) instead of a number or `undefined`.

- A missing suite file, no installed runtime, a failed worker, a failed bundle and a `suite` file without a default export now throw `BenchRunError`, so `arki-bench` prints the message and exits 1 instead of ending with an unhandled rejection. `BenchRunError` is a class now, not an `Error` renamed by string.
- `writeReadme` throws `ReadmeError` and `checkReadme` returns a `reason` when the README cannot be read or written (a directory, no permission), instead of raw `EISDIR` / `EACCES`.

No docs impact beyond the README row for `parseSize`, updated here. No demo impact.
