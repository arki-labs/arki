# arki — Design System

> *"Ship faster. Build smarter."*
>
> The internal design-system kit for **arki**, an open-source TypeScript framework
> family. Center of gravity: `arki.dev` — the public website for the ARKI package
> family and its application-composition kernel, **DOT**.

This kit is the visual + tonal source-of-truth for arki.dev (v1.0). Two
validation apps — **ImagineRooms** and **Horoscorpio** — inherit the brand later
on their marketing surfaces; their consumer UIs deviate by design and are out of
scope here.

---

## Sources

This kit is derived from these provided documents (read-only):

- `arki/design-system-brief.md` — canonical brand brief
- `arki/claude-design-brand-kit.md` — the full brand kit (Part A product · Part B
  aesthetic · Part C system)
- `arki/design-system-decisions.md` — the C-DS-1 to C-DS-10 working assumptions
- `arki/README.md` — original product framing (note: framing predates the
  agent-native rewrite; the brand kit + brief supersede it)
- `arki/claude-design-setup.md` and `arki/claude-design-validation-prompts.md`

There is no live codebase yet — `fleet/design-systems/src/arki/` will be
created **from this kit's output**, not the other way around.

---

## Index

- `colors_and_type.css` — all CSS custom properties (color tokens, type roles,
  spacing, radii, motion). Drop-in for any HTML in this kit.
- `fonts/` — local fallback for Geist / Geist Mono / Instrument Serif (loaded
  from Google Fonts at runtime; see CONTENT FUNDAMENTALS below if those fail).
- `assets/` — logos, favicon studies, ASCII band fixtures.
- `preview/` — the small cards that populate the **Design System** tab in this
  project.
- `ui_kits/arki-dot/` — the arki.dev UI kit. JSX components + interactive
  click-through index.html.
- `SKILL.md` — the cross-compatible skill file (publishable as a Claude Code
  skill).

---

## CONTENT FUNDAMENTALS

### Tone

**Calm utility, code-centric, ambient seriousness.** Reads like the framework's
own source code, not a marketing landing. Confident but not boastful. Active
voice. Short sentences. The reader is a competent senior engineer who has
shipped TypeScript for years — never paraphrase a doc page; link to it.

The only place exuberance is allowed is the **ASCII band** above every page
footer. Everything else is steady.

### Casing & person

- **Brand mark** is always lowercase: `arki`, `dot`, `defineApp`, `@arki/dot`.
  Never `Arki`, never `ARKI` in body copy. Section headings and proper sentence
  starts may capitalize.
- **Voice**: third-person "DOT…" / "the lifecycle…". Avoid "we / us / our"
  overuse (no "we built this for ourselves"). Address the reader as "you" only
  in docs ("you'll need a TypeScript 5.4+ runtime"); marketing copy avoids it.

### Banned (binding)

- `!` — **no exclamation marks anywhere on the site**, hero or otherwise
- Emoji **in chrome** (nav, buttons, headings). Sparingly OK in blog posts.
- `AI-powered` — use *agent-native* instead
- `blazing fast`, `lightning fast`, `10x`, `next-generation`, `revolutionary`,
  `game-changing`
- `just` / `simply` / `it's that easy` — implies the reader is the problem
- `fully typed` without showing the inference in code beside the claim
- `boilerplate` as a dig at competing frameworks (Adonis / Elysia / Hono get
  peer respect, not mockery)
- `unlock`, `unleash`, `supercharge`, `leverage`, `magic`
- Mass adoption claims without a source link ("trusted by 10,000 developers")
- Fake urgency: "early access", "limited spots", countdowns

### Vibe — say / don't say

| ✓ Say                                                          | ✗ Don't say                                       |
| -------------------------------------------------------------- | ------------------------------------------------- |
| `bun add @arki/dot`                                            | "Get started in seconds — it's that easy!"        |
| A TypeScript-first application composition framework.          | A revolutionary AI-powered platform for builders. |
| The `boot` hook fires after `configure` and before `start`.    | Just `boot` your app and you're good to go!       |
| `dot doctor --json` returns a structured failure with a fix URL. | Powerful diagnostics that just work, like magic. |

### Emoji policy

**No emoji in chrome.** No emoji in headings, nav, buttons, or anywhere a
machine reader would parse them as semantic content. ASCII glyphs are the brand
substitute: `●` filled · `○` hollow · `◐` partial · `▸` flow · `⌘` shortcut ·
`⎯` separator.

---

## VISUAL FOUNDATIONS

### Color register

- **Dark-first**, full light-mode parity. Light mode is "paper-printed `man`
  page"; dark mode is "terminal at 2am."
- **Desaturated zinc neutrals + single warm amber accent.** `--accent`
  (`#facc15`) is the only saturated color in chrome — reserved for primary CTA,
  active states, focus rings, and the active ASCII-band glyph. Every other
  surface decays to zinc.
- Status semantics are loaded onto **icon + text label**, never color alone:
  `success` green, `warning` amber, `info` blue, `destructive` red. Charts
  pair color with pattern + label.

See `colors_and_type.css` for full token spec.

### Type

A **multi-mono dev-coded register** — five families, each pulling its weight.

- `sans` — **IBM Plex Sans** (IBM, OFL). Body, headings, lede.
- `mono` — **JetBrains Mono** (JetBrains, OFL). Treated as **first-class equal** to
  sans — version strings, package names, navigation labels, status bars, button
  labels in CLI-page chrome, inline code. The IDE-canonical mono millions of
  developers stare at all day; pure dev cred.
- `code` — **Fira Code** (Mozilla, OFL), **only inside `<pre>` blocks**. The
  programming-ligature font: `=>`, `!==`, `>=`, `|>`, `&&`, `::` render as
  single glyphs. Reserved for code blocks where the ligatures actually fire.
- `crt` — **VT323** (Peter Hull, OFL). Atmospheric bitmap CRT typeface, reserved
  for **the ASCII band's wordmark and tagline**. Nowhere else.
- `serif` — **Instrument Serif** (Rodrigo Fuenzalida, OFL), **rare**. Only the
  `/philosophy` pull-quote.

**Font substitution flagged.** This is a deliberate departure from the brand
kit's C-DS-1 Option A (Geist + Geist Mono). All five families ship from
**Google Fonts** at runtime (every one is OFL). If you need offline-true
fixtures or are vendoring for production, drop `.woff2` files into `fonts/` —
nothing is checked in.

### Density

**Compact** (per C-DS-3 A). Base unit 4px. Body 14px / 22px line. Card padding
16px. Inter-card gap 12px. Section gap 64px. Touch-target floor 44px (binding,
WCAG 2.1 AA).

Long-form pages (`/philosophy`, `/why`) opt-in to **reading mode** — 17px body
at 28px line. The opt-in is per-route, not user-toggleable.

### Backgrounds

- **Solid `--background` token.** No gradients. No photography. No mockup
  laptops. No SVG hero illustration.
- A barely-visible ASCII **code-rain** layer (subtle, ~18% opacity, columns of
  random punctuation + identifiers falling) sits behind the universal ASCII
  band — the only place a textured background appears.
- The single repeating texture in the brand is the **ASCII band** below every
  page's status-bar footer. Full-bleed, ~150px tall, three columns:

  1. **VT323 wordmark** — "arki.dot" in retro CRT bitmap type at 84px, with
     amber phosphor-glow on the period. Tagline `> ship faster_` with a
     blinking caret in VT323 below.
  2. **Live lifecycle conveyor** — five circular nodes (`configure → boot →
     start → stop → dispose`) with one node lit amber at a time, advancing
     every 1.1s. Edges have a subtle amber sweep.
  3. **Cycling terminal** — typewriter-effect terminal that cycles through
     three scripted scenes: `bun add @arki/dot`, `dot doctor`, `dot explain
     --graph`. Each scene types in line-by-line, holds, and rotates.

  Behind all three: **code rain** at 18% opacity — columns of random source
  characters falling vertically at varied speeds.

  The whole band freezes at end-frame under `prefers-reduced-motion: reduce`.

**Six band variants** are shipped, swappable via the Tweaks panel in
`ui_kits/arki-dot/index.html`:

| # | Variant   | What it is                                                                 |
| - | --------- | -------------------------------------------------------------------------- |
| 01 | `ascii`    | Default. VT323 wordmark + lifecycle conveyor + cycling terminal + code rain. |
| 02 | `ticker`   | Two-row package marquee scrolling opposite directions. npm-registry vibe.    |
| 03 | `graph`    | SVG plugin lattice. Amber pulses travel along edges from kernel to satellites. |
| 04 | `monitor`  | Live runtime bars — CPU · MEM · REQ/s · ERR/s. Dashboard-y, drifts via interval. |
| 05 | `kinetic`  | Huge cross-fading brand phrases — "ship faster", "type safe", "agent native". |
| 06 | `pipeline` | Staggered CI rows — lint → typecheck → test → build → pack. Real GitHub Actions vibe. |

Each variant is full-bleed, ~168px tall, shares the same `band-side` chrome
(amber tag · sans title · mono sub-line), and is `aria-hidden="true"` with a
single `sr-only` description above. Pick one per surface — they're alternatives,
not a stack.

### Borders, cards, elevation

- **Bordered, no shadow.** Cards: `1px solid var(--border)`, 6px radius, flat
  `--card` fill (a single tonal lift from `--background`). Hover state shifts
  the border to `--primary` at 40% opacity — **no transform, no lift, no
  shadow**.
- Buttons: 4px radius, 36px height. Inputs: 4px radius, 36px height.
- Sheet/dialog: 8px radius. Backdrop: `--background` at 80% with 4px blur.
- The **only** allowed shadow is a subtle ring on popovers/dialogs in dark
  mode: `0 0 0 1px hsl(foreground / 0.06)`. No drop shadows anywhere else.

### Motion

**Measured.** Reserved for the ASCII band peak.

- Hover transitions: 150ms ease-out, color/opacity only — **no transform**
- Button press: 100ms
- Surface enter: 150ms `cubic-bezier(0.16, 1, 0.3, 1)` (fade + 8px up)
- Surface exit: 100ms same easing, opacity-only
- Number change: 200ms
- Page transitions: **none** — instant route change
- Skeleton: **static rectangles, no shimmer, no pulse**
- ASCII band: ≤8s loop, freezes at end-frame under `prefers-reduced-motion`

### Hover, press, focus, disabled

- **Hover** — color/opacity shift only. Cards: border tints to `--primary @
  40%`. Buttons: fill darkens 6% (light) / lightens 6% (dark). Links:
  underline appears; text color stays.
- **Press** — `--accent` tint flash on the pressed element, 200ms linear,
  no transform/no shrink.
- **Focus** — 2px solid `--ring` (amber), 2px offset, **square corners
  regardless of underlying radius**. Always visible, even in dark mode. Never
  replaced by color change alone.
- **Disabled** — 60% opacity on whole element, cursor `not-allowed`. No
  desaturation, no overlay.

### Transparency & blur

- Used **only** for the modal/sheet backdrop: `--background` at 80%, 4px blur.
- Popovers may use 100% opaque `--popover` over the page (no blur). Tooltips
  100% opaque.
- No frosted-glass nav, no translucent sidebars, no fog gradients.

### Corner radii

- 4px — button, input
- 6px — card (the workhorse radius)
- 8px — sheet / dialog
- 9999px — status pill **only**, used sparingly

### Dividers

1px hairline `--border` between **major regions only**. Never inside cards.
The divider *is* the margin — no extra padding on both sides.

### Imagery — color & treatment

The brand ships **no photography and no illustration**. The only image assets
in the kit are: favicon, OG image (a rendered ASCII frame), and the GitHub
social card. No warm/cool/grain debate to settle — there is nothing to grade.

### Layout rules

- Section gap: 64px between major regions
- Inter-card gap: 12px
- Card padding: 16px
- Sticky right-rail TOC on doc pages — never an "in this article" table at the
  top of body content
- Maximum nav depth: 3 levels (`/docs/concepts/lifecycle` is the floor)
- Breadcrumbs at level 2+
- Long-form column width: 65ch in reading mode

---

## ICONOGRAPHY

**Pack:** [Phosphor Icons](https://phosphoricons.com), **Regular** weight only
(workspace-canonical per C-DS-6 A). Single-weight register — **no duotone or
fill mixing in chrome**.

- Stroke weight: ~1.5px optical at 16px (Phosphor Regular default)
- Sizes paired with type: 16px alongside body, 20px in tabs/chrome, 24px in
  h3, 32px in h2
- Icons sit on the typography baseline, never floated above text

**CLI-credible glyphs preferred** where the concept maps:
`Terminal · File · Code · GitBranch · Package · MagnifyingGlass · Gear · Check
· X · CaretRight · Circle (filled) · Circle (hollow)`

**Distribution.** Phosphor is loaded from CDN
(`https://unpkg.com/@phosphor-icons/web/src/regular/style.css`). For agent or
SSR contexts that can't reach the CDN, install `@phosphor-icons/web` and import
the regular stylesheet directly. No SVGs are checked into `assets/` — Phosphor
is the source of truth.

**Emoji & unicode:** no emoji in chrome (binding). ASCII glyphs substitute
where a single mark is needed: `●` `○` `◐` `▸` `⌘` `⎯` `↳` `→`. The brand mark
itself is the literal period — see `assets/brand-mark.svg`.

**Status pills** carry icon + text + color (never color alone). ASCII variant
in `<pre>` blocks uses `●` (filled) / `○` (hollow) / `◐` (partial) with mono
labels.

---

## UI Kits

- `ui_kits/arki-dot/` — the arki.dev marketing + docs site. Five core screens:
  Home, Concept doc (`/concepts/lifecycle`), CLI man page (`/cli/doctor`),
  Packages catalog (`/packages`), Philosophy (`/philosophy`). Interactive
  click-through `index.html`.

ImagineRooms and Horoscorpio are **out of scope for v1.0** per the brand kit —
no UI kits for them in this design system.

---

## SKILL.md

This kit ships a `SKILL.md` that's cross-compatible with Claude Code
Agent Skills. Read that file when invoking the kit as a downloadable skill.
