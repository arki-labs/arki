AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/native-ui

React Native UI components: React Native Reusables, styled with NativeWind, on rn-primitives. When a doc and the code disagree, `src/components/*.tsx` and `src/lib/*.ts` win.

## Laws

1. This package is native only. The web uses `@arki/ui`.
2. Components style themselves with NativeWind `className` strings. The package defines no theme and no dark mode.
3. Each component has its own export path under `components/<name>`. The root re-exports every value.
4. The helpers in `lib/cn`, `lib/utils` and `lib/colors` import no React Native code. They run on any runtime.
5. A helper does not throw on normal input. `isValidHexColor` returns a boolean.
6. `react`, `react-native`, `nativewind`, `react-native-reanimated`, `react-native-gesture-handler` and `react-native-svg` are peer dependencies. The app owns them.
7. The package ships compiled code. To change a component, copy it from React Native Reusables into the app.
8. A new component needs an export entry in `package.json`, a row in the README and an entry in `docs/api.md`.
9. Types are written once and inferred everywhere.
10. A public export is never deleted because nothing uses it. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block that needs a React Native runtime is marked `skip` with its reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```

The Hermes release app needs a Mac with Xcode: `ARKI_RN_APP=1 bun run test:runtimes`.
