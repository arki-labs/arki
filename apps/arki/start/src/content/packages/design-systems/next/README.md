# @arki/design-systems

Shared visual foundations for ARKI web apps. It gives an app one set of semantic colour tokens, a Tailwind v4 bridge for them, and bundled fonts. It ships tokens and fonts only. Components come from `@arki/ui`.

## Install

```sh
bun add @arki/design-systems
```

## Quick start

Pick one system for the whole app and import its three CSS files after Tailwind.

```css
@import 'tailwindcss';
@import '@arki/design-systems/atelier/fonts.css';
@import '@arki/design-systems/atelier/tokens.css';
@import '@arki/design-systems/atelier/theme-bridge.css';
```

Now `bg-background`, `text-muted-foreground` and `border-border` use the atelier palette. Dark mode follows the `dark` class on `<html>`, which `@arki/theme` sets.

## When not to use this

- You want ready-made components. Use `@arki/ui`, which is built on these tokens.
- You want raw colour scales such as `blue-500` to style from. These are semantic tokens (`primary`, `muted`), not palettes.
- You need a brand of your own that is not one of the shared systems. Add your own token names for it, and keep the shared names untouched (see the rules below).

## Runtime support

Source-distributed: ships TypeScript/TSX, needs a bundler (Vite with the TanStack Start stack).

## Public imports

Each system has the same four files, under its own folder: `atelier`, `workbench`, `arena`, `tribunal`, `gallery`.

| Import | What it is |
| --- | --- |
| `@arki/design-systems/<system>/tokens.css` | The semantic tokens, light and `.dark` |
| `@arki/design-systems/<system>/theme-bridge.css` | Maps the tokens to Tailwind `--color-*` names |
| `@arki/design-systems/<system>/fonts.css` | Self-hosted font faces |
| `@arki/design-systems/<system>/fonts` (or `/<system>`) | `sans`, `mono`, `serif` (and `display` for tribunal): the CSS variable names |
| `@arki/design-systems/registry` | `DESIGN_SYSTEMS`, `DESIGN_SYSTEM_IDS`, `isDesignSystemId`, `parseDesignSystemId`, `resolveDesignSystemId`, `getDesignSystemById`, `getDesignSystemByIdSafe` |
| `@arki/design-systems/typography`, `/palette-labels` | The shapes (Zod schemas) for a system's heading-font roster and mode labels |
| `@arki/design-systems/fonts` | Extra font modules: `cabin`, `gentiumPlus`, `raleway`, `sentient` |
| `@arki/ui/styles/nav.css` | Navigation view-transition styles |

The `gallery` system has CSS and font imports but is not in the registry yet. Its id is not in `DESIGN_SYSTEM_IDS`.

## Supported systems

| System | Character | Best fit |
| --- | --- | --- |
| `atelier` | Warm, scholarly, editorial, trust-heavy | Content-led products, premium calculators, reading and writing tools |
| `workbench` | Calm notebook, monochrome, utility-first | Productivity apps, study tools, denser work surfaces |
| `arena` | Calm chrome, amplified status (win, lose, hint, score), game-piece depth | Games, puzzles, scored surfaces |
| `tribunal` | Cream paper, serif-led, sober verdict bands | Evidence and case-file reports |

The systems differ at the token level:

- **Border radius.** Atelier `0.75rem`, workbench `0.375rem`, arena `0.625rem`.
- **Depth.** Atelier uses warm layered shadows. Workbench uses prominent borders and little lift. Arena uses cool shadows so pieces lift off the table.
- **Primary colour.** Atelier is a saturated amber. Workbench is near-black ink with a pastel-blue accent surface. Arena is a near-foreground cool dark, so the chrome stays calm.
- **Touch targets.** Atelier and workbench keep a 44 by 44 px floor. Arena raises it to 48 by 48 px.
- **Type.** Atelier pairs Plus Jakarta Sans, JetBrains Mono and Fraunces. Workbench pairs Work Sans, IBM Plex Mono and Instrument Serif. Arena uses Inter Variable and JetBrains Mono Variable.

For help choosing, read [`.agents/skills/design-and-ui/choosing-a-design-system.md`](../../.agents/skills/design-and-ui/choosing-a-design-system.md) in the ARKI repository.

## The semantic tokens contract

Every system defines the same token names. Components use only these names, so one component works in every system.

| Group | Tokens |
| --- | --- |
| Surfaces | `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground` |
| Roles | `primary`, `secondary`, `muted`, `accent`, each with a `-foreground` pair |
| Lines and focus | `border`, `input`, `ring`, `radius` |
| Status | `destructive`, `success`, `warning`, `info`, each with a `-surface` tint (and `destructive-foreground`) |
| Charts | `chart-1` to `chart-5` |
| Sidebar | `sidebar-background`, `sidebar-foreground`, `sidebar-primary`, `sidebar-accent`, `sidebar-border`, `sidebar-ring` and their `-foreground` pairs |
| Shape and type | `shadow-sm`, `shadow-md`, `shadow-lg`, `font-sans`, `font-mono`, `font-serif`, `heading-font` |

Arena adds `win`, `lose`, `hint`, `score-positive`, `score-negative`, `score-neutral`, `game-board` and `game-piece`.

The bridge turns each token into a Tailwind colour: `--primary` becomes `bg-primary`, `text-primary`, `border-primary`.

## Rules

1. Use one system per app. Never mix `atelier`, `workbench` and `arena` (or any two) in the same app.
2. Style with semantic classes such as `bg-background`, `bg-card`, `text-muted-foreground` and `border-border`. Do not write raw colours.
3. Add app-specific tokens under new names. Never replace a shared name.
4. If you find a gap in the shared contract, propose the smallest extension and get confirmation before you change it.
5. A new shared system needs its own folder, registry entry, tests and docs in one change.

## Failure behaviour

The registry helpers show how they fail:

- `parseDesignSystemId(value)` throws a `ZodError` for an id that is not supported.
- `resolveDesignSystemId(value, fallback)` never throws. It returns `fallback` (default `atelier`).
- `getDesignSystemByIdSafe(value)` returns `null` for an unknown id. `getDesignSystemById(id)` takes an id that is already typed.

```ts run expect
import { DESIGN_SYSTEM_IDS, getDesignSystemByIdSafe, resolveDesignSystemId } from '@arki/design-systems/registry';

console.log(DESIGN_SYSTEM_IDS.join(', '));
console.log(resolveDesignSystemId('neon'));
console.log(getDesignSystemByIdSafe('neon'));
```

```text
atelier, workbench, arena, tribunal
atelier
null
```

CSS has no errors. A token that is missing renders as an invalid colour, which the browser drops without warning.

## Limits

- The systems share names, not values. `primary` is amber in atelier and near-black in workbench. A screenshot test written for one system fails in another.
- The fonts are bundled. Importing `atelier/fonts.css` inlines about 1 MB of font files into your CSS build. Check the size note in the benchmarks below.
- `tokens.css` has no effect without `theme-bridge.css`, and the bridge has no effect without Tailwind v4 `@theme`. Import all of them, in the order shown.
- The registry has four ids. Boundary: `isDesignSystemId('gallery')` is `false`, even though `gallery/tokens.css` exists.

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

## Documentation

- [docs/agent-guide.md](./docs/agent-guide.md): the model, a task map, the rules that bite, and how to verify.
- [llms.txt](./llms.txt): the short form for agents.

## Support

Report bugs and questions at <https://github.com/arki-labs/arki/issues>.

## License

MIT. See [LICENSE](./LICENSE).
