// Minimal runner for the official Hermes V1 macOS framework (Maven hermes-ios 250829098.0.17).
// Loads a JS file, gives it print(), evaluates it, then drains the microtask queue the way the
// React Native host does (MicrotaskQueue on). The engine is the unmodified release binary.
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
using namespace facebook;
int main(int argc, char **argv) {
  if (argc < 2) { std::cerr << "usage: run file.js | run -version\n"; return 2; }
  if (std::strcmp(argv[1], "-version") == 0) { std::cout << "Hermes V1 250829098.0.17 (hermes-ios release framework, JSI runner)\n"; return 0; }
  std::ifstream in(argv[1]); std::stringstream src; src << in.rdbuf();
  auto config = ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build();
  auto rt = facebook::hermes::makeHermesRuntime(config);
  rt->global().setProperty(*rt, "print", jsi::Function::createFromHostFunction(
    *rt, jsi::PropNameID::forAscii(*rt, "print"), 1,
    [](jsi::Runtime &r, const jsi::Value &, const jsi::Value *args, size_t n) {
      for (size_t i = 0; i < n; i++) std::cout << (i ? " " : "") << args[i].toString(r).utf8(r);
      std::cout << "\n"; std::cout.flush(); return jsi::Value::undefined(); }));
  try {
    rt->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(src.str()), argv[1]);
    while (!rt->drainMicrotasks()) {}
  } catch (const jsi::JSError &e) { std::cout << "JSError: " << e.getMessage() << "\n"; return 1; }
  return 0;
}
