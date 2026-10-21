---
'@arki/embeddings': minor
---

Smaller vectors, and the space before the first embed.

- `truncate(vector, dimensions, model)` keeps the first `dimensions` values of a Matryoshka vector and re-normalises them when the model's vectors are unit length. A size not in `model.matryoshka` is `UnsupportedInput`.
- `quantize(vector, 'binary')` packs one bit per dimension, set above 0, most significant bit first (byte-identical to sentence-transformers and Transformers.js). `unpackBits` turns bits back into ±1 floats, and `hamming` counts differing bits for a first pass.
- `calibrateInt8(sample)` returns one per-dimension `[min, max]` range for a corpus, and `quantize(vector, 'int8', calibration)` maps onto -128…127 with it.
- `createEmbedder` makes binary itself when the provider cannot, and int8 when given a `calibration`. The space then names the calibration (`EmbeddingSpace.calibration`, `…/i8@<16 hex>/…` in `spaceId`), so indexes made with different ranges are different spaces. Breaking: binary is no longer refused for providers without native binary; a size that is not a multiple of 8 is refused with `part: 'dimensions'`.
- `resolveSpace(embedder)` answers the space with Ollama's digest read up front (no embedding), or `ModelUnavailable` with `unreachable` or `not-pulled`. Use it before comparing with stored space ids. Model records gain an optional `loadRevision`.
- `Embedder.spaceFor({ dimensions?, quantization? })` answers the space a call with those options produces. `withCache` keys on it, so a per-call dtype on a calibrated embedder hits its own entries. Breaking for hand-written `Embedder` objects: they need `spaceFor` (`withMiddleware` passes it through).
- `resolveEmbeddingModel(…, { requiredSpace })` now accepts a quantized stored space for the model that made it: the dtype belongs to the embedder, not the model.

Review fixes: `withCache` no longer rebuilds the per-call space itself (a per-call binary on an int8 embedder, or a per-call int8 on a calibrated one, missed every time); `quantize` and `calibrationId` refuse a calibration whose `min` and `max` differ in length.
