---
'@arki/dot': minor
---

Each usecase factory receives its own frozen copy of its deps. A factory that mutated the shared deps object now fails boot with a `TypeError`.
