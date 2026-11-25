# @arki/native-ui

## 0.2.0

### Minor Changes

- f367180: Breaking: `hexToRgba`, `lightenColor` and `darkenColor` read `#rgb`, `#rrggbb` and `#rrggbbaa` correctly (the forms `isValidHexColor` accepts). They keep the alpha pair of an 8-digit hex, and `hexToRgba` multiplies it with its `alpha` argument. Text that is not a `#` hex color now throws `RangeError`, where it used to return a wrong color. Check with `isValidHexColor` first if the text is not under your control.

### Patch Changes

- 744896d: Add the README `Documentation` and `Support` sections, `AGENTS.md` and an agent guide.
- a53f5cb: The Hermes claim now has two proofs. The helpers (`lib/cn`, `lib/utils`, `lib/colors`) run on the bare Hermes V1 runner, as before. The components run in a small Expo app in `app/`, built in release mode on Hermes V1 and run in an iOS simulator, because they need Fabric and the native modules of react-native-svg, reanimated and react-native-screens. The app installs the packed package, renders every component once, opens every overlay, and passes only when each one has laid out natively. Run it with `ARKI_RN_APP=1 bun run test:runtimes`. No API change.

  Docs: README `## Runtime support`.

- 0464500: Internal cleanup of the menubar close call, the toggle group size lookup and the hex color pattern, with no change in behaviour.
- 4f24c6d: Each package README now records what it instruments, including why these packages need no spans.
- 763b232: Declares the engines it supports and documents them in the README.
- 2a9dea1: `lightenColor` and `darkenColor` throw a `RangeError` when `percent` is not finite. Before, `NaN` gave the string `#NaNNaNNaN`, which reached a style prop with no error.

## 0.1.0

### Minor Changes

- ebc681b: `debounce` is typed without `any` and returns a function with `cancel()` for the pending call.
