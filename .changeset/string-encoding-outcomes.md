---
"@arki/string": minor
---

Return canonical InvalidUtf8 and InvalidBase64 failures for malformed encoding input, with unwrapped successes and exact inferred unions. Encoding failures no longer throw StringError. Fluent codecs require failure narrowing before chaining. Breaking: tryFromBase64 aliases fromBase64 and returns its canonical failures instead of null; replace null checks and catches with isFailure. Add @arki/failure as the sole runtime dependency. Valid bytes and strict decoding rules are unchanged.
