---
'@arki/http': minor
---

Handlers can return `@arki/failure` failures. A contract lists them by definition: `route.get('/posts/:id', { id, output, failures: [PostNotFound] })`. When a handler returns or resolves to a failure, the server answers with the failure's status and the usual error envelope, which now carries the failure's `data` too. The output schema does not run on a failure. A handler that can return a failure the contract does not list does not compile. `RouteFailure<typeof contract>` is the union of the listed failures.

`createClient` resolves to the failure instead of throwing when the answer's code is one the contract lists. It rebuilds it with `revive` and checks its data with the definition's schema. The call's type is `Output | the listed failures`, so the frontend can `match` on it. Other error answers still throw `HttpError`.

Security fix: `createClient` refuses a path param that is empty, `.` or `..` and throws `ARKI_HTTP_E400` before sending. Before, `..` in `/orders/:id/cancel` sent the request to `/cancel`, a different endpoint, with the user's cookies.
