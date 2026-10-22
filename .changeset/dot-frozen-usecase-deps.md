---
'@arki/dot': minor
---

Each usecase factory now gets its own frozen copy of its deps. A factory that changes the deps object now fails boot with a `TypeError`. If you did this, build your own object inside the factory instead.
