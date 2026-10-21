# `@arki/design-systems`

Shared visual foundations for Arki web apps.

This package does not replace `@arki/ui` or `@arki/sitekit`. It provides the lower-level brand layer that apps build on:

- semantic color tokens
- Tailwind v4 theme bridges
- shared font exports
- a registry of supported system ids

## Consuming from npm

`@arki/design-systems` is a **source-first** package: CSS files plus TypeScript source as the runtime entry (with `.d.ts` declarations). Your bundler compiles it — Vite, TanStack Start, Next.js and Bun all do; plain Node without a bundler is not supported.

```sh
bun add @arki/design-systems
```

```css
@import 'tailwindcss';
@import '@arki/design-systems/atelier/fonts.css';
@import '@arki/design-systems/atelier/tokens.css';
@import '@arki/design-systems/atelier/theme-bridge.css';
```

Product-specific systems are not part of this package; it ships the shared systems only.

## Supported Systems

| System | Character | Best Fit |
| --- | --- | --- |
| `atelier` | Warm, scholarly, editorial, trust-heavy | Content-led products, premium calculators, reading/writing tools |
| `workbench` | Calm notebook, monochrome, utility-first | Productivity apps, study tools, denser work surfaces |
| `arena` | Calm chrome, AMPLIFIED status (win/lose/hint/score), game-piece depth, Tier 3 motion | Games, puzzles, scored/competitive surfaces |

Beyond character labels, the systems differ at the token level:

- **Border radius** — atelier `0.75rem` (12px, soft) vs workbench `0.375rem` (6px, sharp) vs arena `0.625rem` (10px, game-piece appropriate)
- **Depth strategy** — atelier ships warm-tinted layered shadows; workbench ships borders-prominent + minimal lift via low-opacity pseudo-borders; arena ships cool-neutral layered shadows (pieces lift from the table)
- **Primary color role** — atelier's primary is a saturated amber accent everywhere; workbench's primary is near-black ink with the only color being a pastel-blue accent surface; arena's primary is a near-foreground cool dark (chrome stays calm so the game can pop)
- **Status colors** — every system ships `--destructive`, `--success`, `--warning`, `--info` and a `-surface` tint for each (callout backgrounds);  arena adds AMPLIFIED `--win`/`--lose`/`--hint` plus `--score-positive/-negative/-neutral` and game-surface tokens (`--game-board`, `--game-piece`)
- **Animation feel** — atelier accordions at 250ms (slower, warmer); workbench at 200ms (snappier, utility-focused); arena at 200ms chrome plus Tier 3 celebration animations (`pulse-win` with spring easing, `shake-error`, `deal-card`, `flip-piece`)
- **Touch target floor** — atelier and workbench inherit the 44×44px workspace floor; arena raises it to 48×48px for game pieces and cells (still on the 4px grid)
- **Typography pairing** — atelier: Plus Jakarta Sans / JetBrains Mono / Fraunces (warm, soft); workbench: Work Sans / IBM Plex Mono / Instrument Serif (cool, restrained); arena: Inter Variable / JetBrains Mono Variable / system serif fallback (sans-led; chrome stays calm so the game can pop)

For the full token-level comparison and decision-oriented "how to choose" guidance, see the canonical doc in the design-and-ui agent skill: [`.agents/skills/design-and-ui/choosing-a-design-system.md`](../../.agents/skills/design-and-ui/choosing-a-design-system.md). That file scales as new systems are added — there are no pairwise comparison files.

## Package Surface

### Tokens and Tailwind bridge

```css
@import '@arki/design-systems/atelier/tokens.css';
@import '@arki/design-systems/atelier/theme-bridge.css';
```

or:

```css
@import '@arki/design-systems/workbench/tokens.css';
@import '@arki/design-systems/workbench/theme-bridge.css';
```

or:

```css
@import '@arki/design-systems/arena/tokens.css';
@import '@arki/design-systems/arena/theme-bridge.css';
```

### Fonts

```ts
export { mono, sans, serif } from '@arki/design-systems/atelier/fonts';
```

or:

```ts
export { mono, sans, serif } from '@arki/design-systems/workbench/fonts';
```

or:

```ts
export { mono, sans, serif } from '@arki/design-systems/arena/fonts';
```

### Registry helpers

```ts
import {
  DESIGN_SYSTEMS,
  getDesignSystemById,
  resolveDesignSystemId,
} from '@arki/design-systems/registry';
```

## Shared Font Modules

The package also exports reusable font modules under `@arki/design-systems/fonts/*`.

These are typography ingredients, not full design systems:

- `cabin`
- `gentiumPlus`
- `raleway`
- `sentient`

Use them for app-level font aliases or overrides while keeping the app inside `atelier`, `workbench`, or `arena`.

## Rules

1. Preserve the existing design system for feature work inside an app.
2. Style components with semantic tokens such as `bg-background`, `bg-card`, `text-muted-foreground`, and `border-border`.
3. Add app-specific tokens under new names instead of silently replacing the shared semantic contract.
4. Do not mix design systems in the same app (`atelier`/`workbench`/`arena`).
5. If UI work reveals a reusable gap, propose the smallest clean extension first and get user confirmation before changing the design-system contract.
6. If a new shared system is needed, add a new package entry, registry metadata, tests, and documentation together.

<!-- bench:start -->
## Benchmarks

Size of the CSS that @arki/design-systems ships for one system (atelier), next to the stylesheets of Radix Themes and daisyUI, the common ready-made themes for Tailwind-era apps.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.1 (mitata 1.0.34) · publish, seed 1592639052 · commit 34146416b3 (uncommitted changes) · 2026-10-13.

Versions: @arki/bench 0.0.1 · @arki/design-systems 0.1.1 · @radix-ui/themes 3.3.0 · daisyui 5.7.47 · mitata 1.0.34.

### Design tokens

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/design-systems (atelier tokens) |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/design-systems (atelier tokens)** | 0.1.1 | 674 B | 565 B | 2.1 kB | 1 kB | baseline |
| @arki/design-systems (atelier tokens + bridge) (variant) | 0.1.1 | 1.27 kB | 1.09 kB | 4.57 kB | 1.5 kB | 1.9× larger [1.9–1.9] |
| @radix-ui/themes (tokens) | 3.3.0 | 33.8 kB | 21.6 kB | 152 kB | — | different contract: colour scales and component variables, not semantic tokens |

The bridge maps tokens to Tailwind v4 theme variables. Radix Themes and daisyUI have no equivalent step.

### Self-hosted fonts (atelier fonts.css)

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/design-systems (atelier fonts) |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/design-systems (atelier fonts)** | 0.1.1 | 819 kB | 810 kB | 1.09 MB | 902 kB | baseline |

Six font families as inlined font files. Radix Themes and daisyUI load no fonts.

### Full stylesheet

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/design-systems (atelier tokens + bridge) |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/design-systems (atelier tokens + bridge)** | 0.1.1 | 1.27 kB | 1.09 kB | 4.57 kB | 1.5 kB | baseline |
| @radix-ui/themes (styles.css) | 3.3.0 | 80.8 kB | 49.6 kB | 714 kB | — | different contract: includes component styles; @arki ships tokens only |
| daisyUI (daisyui.css) | 5.7.47 | 154 kB | 71.5 kB | 2.58 MB | — | different contract: includes component styles; @arki ships tokens only |

Radix Themes and daisyUI include styles for every component; daisyUI `daisyui.css` is the pre-built full file. @arki/design-systems ships tokens and a bridge only, so its component styles come from Tailwind in your app and are not in this row.

**Notes**

- The promises differ. @arki/design-systems ships semantic tokens plus a Tailwind v4 bridge and no component styles; components come from @arki/ui and Tailwind generates their CSS in your app. Radix Themes and daisyUI ship colour scales or full component styles, so they are measured but never ranked (`differs`).
- Token rows leave out the font files. The atelier tokens import self-hosted fonts that the bundler inlines, so fonts have their own group, a ceiling and not a typical cost: apps usually serve them as separate cached files.
- The other systems (workbench, arena, tribunal, gallery) are about the same size as atelier.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/design-systems","specHash":"4249dd4bc60cd047","profile":"publish","date":"2026-10-13T08:59:34.752Z","harness":"0.0.1"} -->
<!-- bench:end -->
