# Agent guide: @arki/native-ui

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/components/*.tsx` and `src/lib/*.ts` win.

## The model

1. The components are React Native Reusables wrappers over `@rn-primitives`, styled with NativeWind `className` strings.
2. Import one component from `@arki/native-ui/components/<name>`, or any value from the root `@arki/native-ui`.
3. `Text` sets the text style of its children through `TextClassContext`. `Button`, `Badge` and the menus read it.
4. `Icon` wraps Phosphor React Native icons. Pass the icon with the `as` prop.
5. `lib/cn` merges Tailwind classes with `clsx` and `tailwind-merge`. Later classes win.
6. `lib/utils` and `lib/colors` hold plain helpers with no React Native import.
7. The package defines no theme. Tokens and dark mode come from the app's NativeWind and Tailwind setup.

## Task map

### Show a button

1. `import { Button, Text } from '@arki/native-ui'`.
2. Render `<Button variant="outline" onPress={onPress}><Text>Save</Text></Button>`.

### Merge class names

1. `import { cn } from '@arki/native-ui/lib/cn'`.
2. `cn('px-2 py-1', 'px-4')` returns `'py-1 px-4'`.

### Show initials, shorten text or format a size

1. `import { getInitials, truncate, formatFileSize } from '@arki/native-ui/lib/utils'`.
2. `getInitials('Ada Lovelace')` returns `'AL'`. A single word gives its first two letters.

### Change a color

1. `import { hexToRgba, lightenColor, darkenColor, isValidHexColor } from '@arki/native-ui/lib/colors'`.
2. `hexToRgba('#FF0000', 0.5)` returns `'rgba(255, 0, 0, 0.5)'`.

### Debounce a handler

1. `const save = debounce(fn, 300)` from `@arki/native-ui/lib/utils`.
2. Call `save.cancel()` on unmount to drop the pending call.

## Rules that bite

- Native only. Importing a component in Node, Deno or a browser fails, because it imports `react-native`.
- NativeWind must be set up in the app. Without it `className` does nothing.
- The package defines no theme. Do not look for tokens here.
- The menubar renders closed and opens only on a tap. Sub-menus are closed for the same reason.
- `Icon` needs the `as` prop.
- The helper entries (`lib/cn`, `lib/utils`, `lib/colors`) are safe in any runtime.
- The package ships compiled code. A patch to a component goes into the app's copy, not into `node_modules`.

## Errors

This package has no error codes. Helpers do not throw on normal input, and `isValidHexColor` returns a boolean. A bad prop on a component is a type error.

| Symptom                                             | Cause                             | What to do                                            |
| --------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| `className` has no effect                           | NativeWind is not set up.         | Follow the NativeWind getting-started guide.          |
| An import of a component fails outside React Native | The entry imports `react-native`. | Import only the `lib/*` helpers outside React Native. |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
