# Lucide → Phosphor Migration

**Status:** Every workspace consumer has been migrated. `@arki/icons/lucide` and the bare
`@arki/icons` barrel still re-export Lucide for backwards compatibility, but **no source file
imports from them anymore**. The final step (drop `lucide-react` from the catalog and remove
the Lucide barrel files) waits on browser-level visual QA across apps.

**Done**

- Apps with `<WorkbenchIconDefaults>` mounted (`weight: 'regular'`): `hyphenate`, `sudoku`,
  `typeroom`, `diffdigg`, `ucssr`, `toolsforwords`, `toolsforstructures`, `brandability`,
  `evervest`, `games-platform`, `loonytools`.
- Apps with `<AtelierIconDefaults>` mounted (`weight: 'duotone'`): `ekuation`, `manuscribed`,
  `domodoro`.
- Apps with no shared design system (Phosphor's default `regular` is used): `novelette`,
  `holyspace`/`everseek`, `kapodopera`, `strophie`, `readingpath`, `solitairium`,
  `movietracker`, `forkworks`, `avocabo`.
- Shared packages migrated: `@arki/sitekit`, `@arki/ui/base`, `@arki/ui/chat`,
  `@arki/games/sudoku`, `@arki/games/solitaire-ui`, `@arki/content`, `@arki/rich-text`,
  `@arki/code-editor`, `@arki/images`.

**Still on Lucide (intentional)**

- `packages/ui/icons/src/lucide.ts` and its semantic alias siblings (`heart.ts`,
  `calculator.ts`, etc.) — they keep `@arki/icons/lucide` working as a compat barrel until
  removal.
- `packages/ui/native/src/components/{alert,icon}.tsx` — these import from `lucide-react-native`,
  not the web Lucide. Untouched by this migration.

**Decisions in force**

- **Mode:** Phosphor first, drop Lucide later (additive — both libs ship until removal).
- **Default weight:** per design system. Atelier uses `duotone`; workbench uses `regular`. See
  `src/phosphor-defaults.tsx`. Tune in one place per system.
- **Missing icons:** closest manual mapping — see table below. No Iconify fallback.

## Import paths

```ts
// Primary — every Phosphor icon + IconContext, picks up <AtelierIconDefaults> / <WorkbenchIconDefaults>.
import { Heart, MagnifyingGlass } from '@arki/icons/phosphor';

// SSR-safe / static — smaller bundle, ignores IconContext. Use in RSC and hot lists.
import { Heart } from '@arki/icons/phosphor/ssr';

// Per-design-system providers — mount once near the app root.
import { AtelierIconDefaults, WorkbenchIconDefaults } from '@arki/icons/phosphor/defaults';
```

Existing imports keep working unchanged:

```ts
import { Heart } from '@arki/icons/lucide';   // unchanged, still Lucide
import { Heart } from 'lucide-react';         // unchanged, still Lucide
```

## Wiring per app

Mount the per-design-system provider once near the root (where `AppProvider` /
the Tailwind theme lives):

```tsx
// atelier app
<AtelierIconDefaults>
  <App />
</AtelierIconDefaults>

// workbench app
<WorkbenchIconDefaults>
  <App />
</WorkbenchIconDefaults>
```

Anything underneath rendered from `@arki/icons/phosphor` inherits `weight`, `size`,
and `color` defaults. Override per-call by passing the same prop (`<Heart weight="bold" />`).

## Prop mapping

| Lucide                | Phosphor                                                          | Notes                                                                                                  |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `size={n}`            | `size={n}`                                                        | Same.                                                                                                  |
| `color="#…"`          | `color="#…"`                                                      | Same.                                                                                                  |
| `strokeWidth={n}`     | `weight="thin\|light\|regular\|bold"`                             | Discrete weights, not a numeric stroke. `1` ≈ `light`, `1.5–2` ≈ `regular`, `2.5+` ≈ `bold`.           |
| _(no fill variant)_   | `weight="fill"`, `weight="duotone"`                               | Phosphor only. Use for filled or two-tone marks.                                                       |
| `aria-label="…"`      | `alt="…"`                                                         | Phosphor's `alt` sets `<title>` and aria-label.                                                        |
| `className="…"`       | `className="…"`                                                   | Same. Tailwind `text-*` still drives `color` via `currentColor`.                                       |

## Name mapping (curated)

Direct match (Phosphor name == Lucide name): **196** of the 457 unique icons in use.
Only the ones that need a rename are listed here. Counts are total occurrences in the
workspace at the time of writing.

### Renames you'll hit constantly

| Lucide                                    | Phosphor                              |  Uses |
| ----------------------------------------- | ------------------------------------- | ----: |
| `Maximize2`                                | `CornersOut`                          |  79 |
| `Minimize2`                                | `CornersIn`                           |  77 |
| `TrendingUp`                               | `TrendUp`                             |  57 |
| `Search`                                   | `MagnifyingGlass`                     |  55 |
| `Loader2`                                  | `CircleNotch` (animated) or `Spinner` |  54 |
| `Sparkles` / `Sparkle`                     | `Sparkle` (singular)                  |  49 |
| `ChevronRight`                             | `CaretRight`                          |  47 |
| `ChevronDown`                              | `CaretDown`                           |  43 |
| `ChevronLeft`                              | `CaretLeft`                           |  29 |
| `ChevronUp`                                | `CaretUp`                             |  12 |
| `AlertCircle`                              | `WarningCircle`                       |  43 |
| `AlertTriangle` / `TriangleAlert`          | `Warning`                             |  39 |
| `Trash2`                                   | `Trash`                               |  40 |
| `RotateCcw`                                | `ArrowCounterClockwise`               |  29 |
| `RefreshCw` / `RefreshCcw`                 | `ArrowsClockwise`                     |  29 |
| `Settings`                                 | `Gear`                                |  25 |
| `Settings2`                                | `GearSix`                             |     |
| `Zap`                                      | `Lightning`                           |  24 |
| `ExternalLink`                             | `ArrowSquareOut`                      |  24 |
| `CheckCircle2`                             | `CheckCircle`                         |  21 |
| `MessageSquare`                            | `ChatTeardrop`                        |  20 |
| `MessageCircle`                            | `ChatCircle`                          |     |
| `Share2`                                   | `ShareNetwork`                        |  15 |
| `Home`                                     | `House`                               |  14 |
| `Film`                                     | `FilmStrip`                           |  13 |
| `BarChart3` / `BarChart2` / `BarChart`     | `ChartBar`                            |  21+ |
| `LineChart`                                | `ChartLine`                           |     |
| `PieChart`                                 | `ChartPie`                            |     |
| `Award`                                    | `Medal` (or `Trophy` if it's already a trophy semantic) |  12 |
| `HelpCircle`                               | `Question`                            |  11 |
| `Edit` / `Edit2` / `Edit3`                 | `PencilSimple` / `Pencil` / `NotePencil` |  11+ |
| `Save`                                     | `FloppyDisk`                          |   9 |
| `Mail`                                     | `Envelope`                            |   9 |
| `LogIn`                                    | `SignIn`                              |  10 |
| `FlaskConical`                             | `Flask`                               |  10 |
| `EyeOff`                                   | `EyeSlash`                            |  10 |
| `Activity`                                 | `Pulse`                               |  10 |
| `MoreHorizontal`                           | `DotsThree`                           |  10 |
| `MoreVertical`                             | `DotsThreeVertical`                   |     |
| `LayoutGrid` / `Grid3X3` / `Grid3x3`       | `SquaresFour` (or `GridFour`)         |   8+ |
| `Layers`                                   | `StackSimple`                         |   7 |
| `Send`                                     | `PaperPlaneRight`                     |   7 |
| `StickyNote`                               | `Note`                                |     |
| `Smartphone`                               | `DeviceMobile`                        |     |
| `Pin`                                      | `PushPin`                             |     |
| `ListOrdered`                              | `ListNumbers`                         |     |
| `Languages`                                | `Translate`                           |     |
| `Gamepad2`                                 | `GameController`                      |     |
| `Bot`                                      | `Robot`                               |     |
| `BellOff`                                  | `BellSlash`                           |     |
| `Volume2`                                  | `SpeakerHigh`                         |     |
| `Undo`                                     | `ArrowUUpLeft`                        |     |
| `Redo`                                     | `ArrowUUpRight`                       |     |
| `MoveHorizontal` / `Move`                  | `ArrowsLeftRight` / `ArrowsOutCardinal`|     |
| `ArrowLeftRight`                           | `ArrowsLeftRight`                     |     |
| `ClipboardCopy`                            | `Clipboard`                           |     |
| `ClipboardList`                            | `ClipboardText`                       |     |
| `CloudOff`                                 | `CloudSlash`                          |     |
| `WifiOff`                                  | `WifiSlash`                           |     |
| `Droplets` / `Droplet`                     | `Drop`                                |     |
| `Dices`                                    | `DiceFive` (pick a face)              |     |
| `DollarSign`                               | `CurrencyDollar`                      |     |
| `Banknote`                                 | `Money`                               |     |
| `Type`                                     | `TextT` or `TextAa`                   |     |
| `Trees`                                    | `Tree`                                |     |
| `Telescope`                                | `Binoculars`                          |     |
| `Maximize`                                 | `CornersOut`                          |     |
| `Beaker` / `BeakerIcon`                    | `TestTube`                            |     |
| `BookText`                                 | `BookOpenText`                        |     |
| `BookMarked`                               | `BookBookmark`                        |     |
| `FileSpreadsheet`                          | `FileXls`                             |     |
| `FileDown`                                 | `FileArrowDown`                       |     |
| `FunctionSquare`                           | `Function`                            |     |
| `CalendarDays`                             | `CalendarDots`                        |     |
| `Scale`                                    | `Scales`                              |  14 |

### Direct matches (no rename needed)

These exist under the same name in both libraries — only the import path changes:

`ArrowDown`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `Bell`, `Bookmark`, `BookOpen`, `Calculator`,
`Calendar`, `Car`, `Check`, `Circle`, `Clock`, `Copy`, `CreditCard`, `Crosshair`, `Download`,
`Eye`, `Globe`, `Heart`, `History`, `Info`, `Keyboard`, `Layout`, `Lightbulb`, `Link`, `List`,
`Lock`, `MapPin`, `Minus`, `Moon`, `Pause`, `Percent`, `Play`, `Plus`, `Receipt`, `Ruler`,
`Share`, `Shield`, `ShieldCheck`, `Star`, `Sun`, `Target`, `Trophy`,
`Upload`, `User`, `UserPlus`, `Users`, `X`, `XCircle`, ...and 145 more.

(See `bun -e "import('@arki/icons/phosphor').then(m => …)"` to verify any specific name.)

### `Loader2` — special case

Lucide's `Loader2` is _always_ rotated. Phosphor's `CircleNotch` and `Spinner` aren't —
you add the spin in CSS:

```tsx
<CircleNotch className="animate-spin" />
```

If you want Phosphor's spinner with Lucide's exact behavior, wrap once in a local
component and reuse.

### `*Icon` aliases

Phosphor v2 ships every icon under both forms (`Heart` and `HeartIcon`). So if your
code does `import { HeartIcon } from 'lucide-react'`, it works after switching to
`import { HeartIcon } from '@arki/icons/phosphor'`. Exception: aliases for renamed
icons don't exist (`SearchIcon` is not a Phosphor export — use `MagnifyingGlassIcon`).

## Migration order (suggested)

Sweep apps from least-shared to most-shared so visual regressions show up before they
compound.

1. **Standalone tools** with `workbench` (sudoku, typeroom, hyphenate, structurize, diffdigg, ucssr, toolsforwords).
2. **Standalone editorial** with `atelier` (ekuation, manuscribed, domodoro).
3. **Shared-component packages** that serve multiple apps last (`@arki/sitekit`,
   `@arki/ui`, `@arki/chat-ui`, `@arki/auth`, `@arki/books`, `@arki/games/*`).
4. **Drop `lucide-react`** from root catalog and from `@arki/icons` `package.json`,
   delete `src/lucide.ts` and the per-icon Lucide aliases (`heart.ts`, `calculator.ts`,
   etc.) — only after every consumer is off Lucide.

Per-app sweep recipe:

1. `grep -rE "from ['\"](lucide-react|@arki/icons/lucide)['\"]" apps/<app>/`
2. Replace imports with `@arki/icons/phosphor`, applying renames from the table above.
3. Mount `<AtelierIconDefaults>` or `<WorkbenchIconDefaults>` once at the app root.
4. Visually QA the most-trafficked screens — `weight="duotone"` shifts visual density noticeably.
5. Drop `lucide-react` from the app's `package.json` once nothing imports it.
