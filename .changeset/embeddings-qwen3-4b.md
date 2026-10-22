---
'@arki/embeddings': minor
---

`./ollama` knows `qwen3-embedding:4b`, the fleet's GPU tier: 2,560 dims with Matryoshka sizes down to 256, 32,768 input tokens and the Qwen3 prefixes, so it no longer needs `dimensions` and `instruction` passed by hand.
