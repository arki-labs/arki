---
"@arki/ui": patch
---

Outside values no longer crash a page:

- `ResizablePanelGroup` with `autoSaveId`, and `ToolPanelGroup`, read the saved layout through a schema. A saved layout of the wrong shape, or for a different number of panels, is ignored and the default layout is used; the next save replaces it.
- `PanelExpandButton` restore no longer throws when a panel mounted or unmounted while another was maximized; the collapsed panels expand instead.
- `MathInput` and `ComplexInput` render a `NaN` value (for example 0/0) instead of failing with "Too many re-renders".
- `DatePicker` shows the calendar day of any valid `Date`, including the largest one.
- `Calendar` falls back to the browser time zone for an unknown `timeZone` (logged at DEBUG under `arki:ui:calendar`), ignores a `month`, `defaultMonth`, `today`, `startMonth` or `endMonth` that is an Invalid Date or within a month of the ends of the Date range, and treats a range with such an end as no range.

`zod`, `@arki/schema` and `@arki/failure` are new dependencies.
