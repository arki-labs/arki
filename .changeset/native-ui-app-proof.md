---
'@arki/native-ui': patch
---

The Hermes claim now has two proofs. The helpers (`lib/cn`, `lib/utils`, `lib/colors`) run on the bare Hermes V1 runner, as before. The components run in a small Expo app in `app/`, built in release mode on Hermes V1 and run in an iOS simulator, because they need Fabric and the native modules of react-native-svg, reanimated and react-native-screens. The app installs the packed package, renders every component once, opens every overlay, and passes only when each one has laid out natively. Run it with `ARKI_RN_APP=1 bun run test:runtimes`. No API change.

Docs: README `## Runtime support`.
