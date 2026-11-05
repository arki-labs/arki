---
'@arki/embeddings': patch
---

Provider requests now keep their 60 s timeout and the caller's cancel on React Native. React Native's
`AbortSignal` has no `timeout` and no `any`, so every provider request failed there before it was sent.
It now uses a controller and a timer where those two are missing, with the same outcomes: a timeout is
`ModelUnavailable` (`unreachable`), a cancel is `Cancelled`. Other engines are unchanged. The package is
now proven on Node, Bun, Deno, browsers and Hermes.

no docs impact: public API unchanged; the README runtimes table is refreshed.
no demo impact: no demo runs on React Native.
