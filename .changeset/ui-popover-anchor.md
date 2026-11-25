---
"@arki/ui": patch
---

`PopoverContent` takes an `anchor` option, passed to Base UI's `Popover.Positioner`. It places the
panel against an element other than the trigger: an element, a ref, a virtual element or a function
returning one. `--anchor-width` then reads that element's width, so a small trigger can open a panel
as wide as the row it sits in. Unset, the trigger stays the anchor, as before.

Docs: `docs/components.md` (Overlays) names the option.
no demo impact: no demo opens a popover against another element.
