---
'@arki/dot': patch
---

`errorCaptureMiddleware({ report })` in `@arki/dot/orpc`: an oRPC middleware that reports a procedure's unexpected failures to `report(error, { path })` and rethrows every error unchanged. An `ORPCError` below 500 is not reported; a reporter that throws is logged at warn on `arki:dot:orpc` and never replaces the procedure's error. Written on an empty context, so it fits any implementer. New type `ErrorCaptureInfo`.
