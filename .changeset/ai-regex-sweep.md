---
"@arki/ai": patch
---

The default prompt-injection pattern for `unlock … mode` reads a line once. A long line of `unlock` words with no `mode` made it read on from every one. It matches the same input; the reported match now starts at the last `unlock` before `mode`.
