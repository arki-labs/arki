---
'@arki/date': patch
---

Run on React Native's Hermes: `businessCalendar`, interval merging and parsing no longer call `Array.prototype.toSorted`, which Hermes V1 lacks. Each call sorted a fresh array, so behaviour is unchanged.
