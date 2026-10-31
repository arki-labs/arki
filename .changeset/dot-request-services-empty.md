---
'@arki/dot': patch
---

`requestServices([])` provides an empty record, not `unknown`, so `providesOf` accepts a gateway whose app has no contract features yet (only legacy routers mounted beside it).

no docs impact: the documented gateway recipe is unchanged; it now also compiles with an empty feature list.
no demo impact: no demo builds a gateway with no features.
