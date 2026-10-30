---
'@arki/journal': minor
---

`.parallel(name, { [branch]: b => ... }, { wait: 'all' | 'any' })` runs branches side by side as child runs of their own definitions. `'all'` gives the outputs by branch name. `'any'` gives `{ branch, result }` of the first to complete, cancels the others, and completes after each has stopped. A signal for the parent reaches every branch that waits for it, an event wait in a branch counts from the parent's start, and each branch run counts its own transitions. A branch can declare `b.output(schema)`; when every branch does, `def.read` types and checks the node. Existing node kinds keep their shape hashes, and old `ChildrenPlanned` events and running `.map` runs replay unchanged.
