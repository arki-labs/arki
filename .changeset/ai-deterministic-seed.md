---
'@arki/ai': patch
---

Deterministic mode: `createLLMProvider({ deterministicSeed })`, or env `AI_DETERMINISTIC_SEED`, runs every call at temperature 0 with that seed (overriding any per-call temperature), so a real local model answers one input the same way run after run. `new OllamaService({ deterministicSeed })` follows the same rule (same env default). Meant for tests; providers that honour a seed (Ollama does) become repeatable. (The code shipped in 3ab611cf9b; this records it.)
