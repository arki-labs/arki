---
'@arki/content': minor
---

`parseFeed` returns failures instead of throwing `FeedError`: `content.feed_too_large`, `content.feed_malformed`, `content.feed_unsupported`, `content.feed_limit_exceeded` (exported as `FeedTooLarge`, `FeedMalformed`, `FeedUnsupported`, `FeedLimitExceeded`). `FeedError` and `FeedErrorCode` are removed. `generateRss` and `generateAtom` skip an Invalid Date instead of throwing. `@arki/failure` is now a dependency.
