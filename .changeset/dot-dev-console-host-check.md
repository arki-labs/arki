---
'@arki/dot': patch
---

The `dot dev` console answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise), so a page on another site cannot read it through DNS rebinding. A malformed escape in a page path is a 404, and a page that fails to render is a 500; neither stops the console.

no docs impact: the console's behaviour for its own URLs is unchanged.
no demo impact: no demo opens the console.
