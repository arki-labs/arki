# arki.dev — UI Kit

Click-through recreation of the arki.dev public website. Five core screens:

- **Home** (`/`) — install command + `defineApp(...)` hero + ASCII band
- **Concept** (`/docs/concepts/lifecycle`) — doc page with sticky right-rail TOC
- **CLI man page** (`/cli/doctor`) — Unix `man(1)` structure, JSON envelope panel
- **Packages catalog** (`/packages`) — filter chip rail + status-grouped table
- **Philosophy** (`/philosophy`) — reading-mode (17/28) doctrine page

Open `index.html` to navigate between screens via the top nav.

## Files

- `index.html` — entry; loads React + Babel + Phosphor; mounts `<App>`
- `app.css` — kit-specific layout (chrome, body grid, ASCII band positioning)
- `components/chrome.jsx` — `<Nav>`, `<StatusBar>`, `<ASCIIBand>`
- `components/primitives.jsx` — `<Button>`, `<Pill>`, `<CodeBlock>`, `<Card>`,
  `<Kbd>`, `<Provenance>`
- `screens/Home.jsx`
- `screens/Concept.jsx`
- `screens/Cli.jsx`
- `screens/Packages.jsx`
- `screens/Philosophy.jsx`
- `app.jsx` — router + App shell (mounts last)

## Notes

- Dark mode is the canonical register. A theme toggle lives in the status bar
  but the kit defaults to dark.
- All copy is fixtural, drawn straight from the brand kit.
- Everything is selectable text — no canvas-rendered code, no SVG-rendered
  type — per the binding accessibility floor.
