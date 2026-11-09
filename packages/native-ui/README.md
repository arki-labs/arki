# @arki/native-ui

React Native UI components for ARKI. They are the [React Native Reusables](https://reactnativereusables.com/) components, styled with [NativeWind](https://www.nativewind.dev/) and built on [rn-primitives](https://github.com/roninoss/rn-primitives) for accessibility. The package also ships small helpers for class names, strings and colors.

## Install

```sh
npm install @arki/native-ui
# or
bun add @arki/native-ui
# or
pnpm add @arki/native-ui
```

Your app must already have these peer dependencies: `react`, `react-native`, `nativewind`, `react-native-reanimated`, `react-native-gesture-handler` and `react-native-svg`. NativeWind must be set up in your app: follow the [NativeWind guide](https://www.nativewind.dev/getting-started/react-native).

## Quick start

Import a component from the package root or from its own path. Pass NativeWind `className` strings.

```tsx skip="needs a React Native runtime and NativeWind, which this docs check does not start"
import { Button, Text } from '@arki/native-ui';

export function SaveButton({ onPress }: { onPress: () => void }) {
  return (
    <Button variant="outline" onPress={onPress}>
      <Text>Save</Text>
    </Button>
  );
}
```

The helpers need no React Native, so this block runs.

```ts
import { cn } from '@arki/native-ui/lib/cn';
import { getInitials, truncate } from '@arki/native-ui/lib/utils';
import { hexToRgba } from '@arki/native-ui/lib/colors';

export const demo = {
  classes: cn('px-2 py-1', 'px-4'), // 'py-1 px-4'
  initials: getInitials('Ada Lovelace'), // 'AL'
  short: truncate('A long pizza menu title', 10),
  overlay: hexToRgba('#FF0000', 0.5), // 'rgba(255, 0, 0, 0.5)'
};
```

## When not to use this

- You build for the web. These components render with React Native and `rn-primitives`. Use `@arki/ui` for the web.
- You do not use NativeWind. The components style themselves with `className` strings and need it.
- You want to edit component source in your own repo. This package ships compiled code. Copy the file from React Native Reusables instead.

## Runtime support

React Native with Expo or Metro. The component entries import `react-native`, so they do not load in plain Node, Deno or a browser. The helpers in `lib/cn`, `lib/utils` and `lib/colors` import no React Native code and run on any runtime.

The Hermes row has two proofs:

- The helpers run on the bare Hermes V1 runner (`scripts/smoke.mjs`).
- The components run in `app/`, a small Expo app built in release mode on Hermes V1 and run in an iOS simulator. The app installs this package from its packed tarball, renders every component once, opens every overlay (dialog, alert dialog, popover, tooltip, hover card, dropdown menu, context menu, select), and passes only when each one has laid out natively. The menubar renders closed: it opens only on a tap, and the app does not tap. Sub-menus stay closed for the same reason. Run it on a Mac with Xcode: `ARKI_RN_APP=1 bun run test:runtimes`.

The version column says which proof ran: `runner + iOS release app`, or `runner only (app not run)`.

<!-- runtimes:start -->
| Runtime | Result | Version tested | Date (UTC) |
| --- | --- | --- | --- |
| purity | fail | unknown | 2026-11-05 |
| node | n/a | - | 2026-11-05 |
| bun | n/a | - | 2026-11-05 |
| deno | n/a | - | 2026-11-05 |
| browser | n/a | - | 2026-11-05 |
| hermes | pass | V1 250829098.0.17, runner + iOS release app | 2026-11-05 |
<!-- runtimes:end -->

## Public imports

| Import | What it gives you |
| --- | --- |
| `@arki/native-ui` | Every component and helper below. |
| `@arki/native-ui/components/<name>` | One component: `accordion`, `alert`, `alert-dialog`, `aspect-ratio`, `avatar`, `badge`, `button`, `card`, `checkbox`, `collapsible`, `context-menu`, `dialog`, `dropdown-menu`, `hover-card`, `icon`, `input`, `label`, `menubar`, `native-only-animated-view`, `popover`, `progress`, `radio-group`, `select`, `separator`, `skeleton`, `switch`, `tabs`, `text`, `textarea`, `toggle`, `toggle-group`, `tooltip`. |
| `@arki/native-ui/lib/cn` | `cn(...classes)`: merges Tailwind classes; later classes win. |
| `@arki/native-ui/lib/utils` | `getInitials`, `truncate`, `formatFileSize`, `debounce`. |
| `@arki/native-ui/lib/colors` | `isValidHexColor`, `hexToRgba`, `lightenColor`, `darkenColor`. |

### Helpers

- `cn('px-2 py-1', 'px-4')` returns `'py-1 px-4'`. It uses `clsx` and `tailwind-merge`.
- `getInitials('John Doe')` returns `'JD'`. A single word gives its first two letters.
- `truncate(text, length)` shortens long text. `formatFileSize(bytes)` formats a byte count.
- `debounce(fn, delay)` returns the debounced function. Call `.cancel()` on it to drop the pending call, for example on unmount.
- `hexToRgba('#FF0000', 0.5)` returns `'rgba(255, 0, 0, 0.5)'`. `lightenColor(hex, percent)` and `darkenColor(hex, percent)` return a changed hex color.

## Failure behaviour

None of the helpers throws on normal input. `isValidHexColor` returns a boolean. `hexToRgba`, `lightenColor` and `darkenColor` throw `RangeError` for text that is not a hex color; `lightenColor` and `darkenColor` also throw it for a percent that is not finite (`NaN`, `Infinity`). Components follow React Native: bad props are a type error, not a runtime failure.

## Observability

Renders in the app's own process and does no I/O of its own, so the app's spans cover it and the package adds none.

## Limits

- Dark mode and theme tokens come from your NativeWind and Tailwind setup. This package defines no theme.
- `Icon` wraps [Phosphor React Native](https://github.com/duongdev/phosphor-react-native) icons. Pass the icon with the `as` prop.

## Documentation

- [API reference](docs/api.md): every exported value, by import path.
- [Agent guide](docs/agent-guide.md): the model, the task map, the rules and the errors.
- [llms.txt](llms.txt): the import map for agents.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, your React Native and NativeWind versions, and whether you run Expo.
