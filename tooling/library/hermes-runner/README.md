# Hermes V1 runner

`run.cpp` is a small JSI runner around the official Hermes V1 engine. `arki-runtimes` runs the Hermes leg with it (`HERMES_BIN`). No binaries are committed.

Download the engine (Maven `com.facebook.hermes:hermes-ios:250829098.0.17`):

```sh
curl -LO https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/250829098.0.17/hermes-ios-250829098.0.17-hermes-ios-release.tar.gz
echo "2967ee51b41bd433b3027dda875e96194354e2b4d715f9f186fd0c04ccef309d  hermes-ios-250829098.0.17-hermes-ios-release.tar.gz" | shasum -a 256 -c
mkdir hermes-ios && tar -xzf hermes-ios-250829098.0.17-hermes-ios-release.tar.gz -C hermes-ios
```

Build (the tarball has `hermesvm.framework` for macOS but no CLI):

```sh
D=$PWD/hermes-ios/destroot; clang++ -std=c++20 -O2 run.cpp -I$D/include -F$D/Library/Frameworks/macosx -framework hermesvm -Wl,-rpath,$D/Library/Frameworks/macosx -o run
```

Then `HERMES_BIN=$PWD/run arki-runtimes --only hermes`.
