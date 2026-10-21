---
'@arki/content': minor
---

Adds RSS and Atom parsing and generation as `@arki/content/rss` (`parseFeed`, `FeedError`, feed types) and `@arki/content/rss/generate` (`generateRss`). The code comes unchanged from the private `@arki/rss` package, which is retired. `@arki/content` now depends on `fast-xml-parser` directly instead of `@arki/rss`.

no demo impact: neither demo (drop-studio, faultline) imports `@arki/content` or `@arki/rss`.
