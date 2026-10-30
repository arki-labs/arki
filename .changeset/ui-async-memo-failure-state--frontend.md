---
'@arki/ui': minor
---

`useAsyncMemo` now returns `{ value, isPending, failure, retry }` instead of the bare value. A rejected promise becomes `failure` instead of an unhandled rejection, and `retry()` runs the factory again. `useViewport` returns the server desktop default on the first client render and reads the real window after mount, so a phone no longer hydrates different markup. `DatePicker` shows the placeholder for an invalid `Date`. `useFormField` names `<Form>` or `<FormField>` as the missing parent (the field context default is now `null`). Touch-feedback errors log through `@arki/log` at debug (`arki:ui:touch`). New subpath `@arki/ui/copy-text` (`copyText`, moved from `@arki/chat-ui` so `Pre` and `CodeBlock` share one clipboard helper). Chart tooltip and legend items are typed, no `any`.
