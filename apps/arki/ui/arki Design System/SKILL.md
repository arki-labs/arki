---
name: arki-design
description: Use this skill to generate well-branded interfaces and assets for arki, the open-source TypeScript framework family (and its application-composition kernel, DOT). Covers arki.dev — the public marketing + docs + agent-readable website. Contains design guidelines, color and type tokens, the four binding design principles, brand voice (banned words, peer respect), iconography (Phosphor Regular), motion register (measured + ASCII band peak), accessibility floor, and UI kit components recreating the canonical arki.dev surfaces.
user-invocable: true
---

# arki — Design Skill

Read `README.md` first; it's the manifest. Then explore the other files as needed:

- `colors_and_type.css` — drop-in CSS custom properties. Dark-first, light-mode parity. Multi-mono dev-coded font stack loaded from Google Fonts:
  - **IBM Plex Sans** — body / headings (`--font-sans`)
  - **JetBrains Mono** — first-class mono, used everywhere mono appears (`--font-mono`)
  - **Fira Code** — code blocks only, with programming ligatures (`--font-code`)
  - **VT323** — retro CRT bitmap, reserved for the ASCII band wordmark (`--font-crt`)
  - **Instrument Serif** — rare /philosophy pull-quote (`--font-serif`)

  Plus compact 4px-base spacing scale, 4/6/8px radii, motion durations, focus-ring helpers.
- `assets/` — wordmarks (light/dark), favicon, brand mark (the literal `.`).
- `preview/` — 26 design-system specimen cards (Type, Colors, Spacing, Components, Brand). Useful as visual references for what each token *looks like in use*.
- `ui_kits/arki-dot/` — interactive click-through recreation of arki.dev. Five screens (Home, Concept, CLI man page, Packages catalog, Philosophy reading mode). React + Babel, no build step.

## Hard rules to remember (binding)

1. **No exclamation marks** anywhere on the site. **No emoji in chrome** (nav, buttons, headings). **No "AI-powered"** — use `agent-native`.
2. **Dark mode first**, full light-mode parity. The only saturated color in chrome is amber (`#facc15`); everything else is desaturated zinc.
3. **Bordered, no shadow.** Cards are `1px solid var(--border)` with a flat fill. Hover shifts the border, never lifts.
4. **Compact density.** 14px body, 4px base spacing unit. Touch target floor 44px.
5. **Mono is first-class equal to sans.** Versions, packages, nav labels, status bars, button labels in CLI chrome — all mono.
6. **ASCII art is first-class.** No SVG illustrations, no photography, no mascots. Diagrams (DAGs, lifecycle conveyors, state machines) are ASCII inside `<pre>`. The brand's single motion peak is the **full-bleed ASCII band below the status-bar footer** — VT323 wordmark + live lifecycle conveyor + typewriter terminal + low-opacity code rain. Use it on every page.
7. **Every public claim has a provenance link** to a fixture, test, or CI run. Code blocks show their source-of-truth file path.
8. **Status pills carry icon + text + color.** Never color alone.
9. **Focus rings always visible.** 2px solid `--ring` (amber), 2px offset, square corners regardless of underlying radius.
10. **Peer respect.** AdonisJS, Elysia, Hono get framed as "different jobs," never ridiculed.

## What you can do

- **Visual artifacts (slides, mocks, throwaway prototypes).** Copy assets out of this skill folder, write static HTML, and load `colors_and_type.css` at the top. Compose with the patterns in `ui_kits/arki-dot/` — the chrome (Nav, StatusBar, ASCIIBand) is reusable. Phosphor icons via CDN: `<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css">`.
- **Production code.** The CSS tokens map cleanly to a shadcn-style `tokens.css`; the JSX in `ui_kits/arki-dot/` is intentionally simple and meant to inspire structure, not to be shipped verbatim. Treat the `colors_and_type.css` token names as the contract.

## If invoked without guidance

Ask the user what they want — a marketing page, a doc surface, a CLI page, an agent recipe, a slide, or something else. Then ask the questions that matter for that artifact (audience, content density, dark/light, motion budget). Act as a senior designer who knows arki's register and will refuse a brief that violates the binding rules above — push back instead of compromising.
