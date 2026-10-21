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
- **Status colors** — atelier and workbench ship only `--destructive`; arena adds AMPLIFIED `--win`/`--lose`/`--hint` plus `--score-positive/-negative/-neutral` and game-surface tokens (`--game-board`, `--game-piece`)
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
