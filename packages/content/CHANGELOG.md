# @arki/content

## 0.2.1

### Patch Changes

- 4f24c6d: Each package README now records what it instruments, including why these packages need no spans.
- 744896d: Add the agent guide, AGENTS.md and the missing README sections, and fix the doc errors in these packages.
- 763b232: Declares the engines it supports and documents them in the README.

## 0.2.0

### Minor Changes

- 1511bbd: Adds RSS and Atom parsing and generation as `@arki/content/rss` (`parseFeed`, `FeedError`, feed types) and `@arki/content/rss/generate` (`generateRss`). The code comes unchanged from the private `@arki/rss` package, which is retired. `@arki/content` now depends on `fast-xml-parser` directly instead of `@arki/rss`.

  no demo impact: neither demo (drop-studio, faultline) imports `@arki/content` or `@arki/rss`.

- f3c95a0: `parseFeed` returns failures instead of throwing `FeedError`: `content.feed_too_large`, `content.feed_malformed`, `content.feed_unsupported`, `content.feed_limit_exceeded` (exported as `FeedTooLarge`, `FeedMalformed`, `FeedUnsupported`, `FeedLimitExceeded`). `FeedError` and `FeedErrorCode` are removed. `generateRss` and `generateAtom` skip an Invalid Date instead of throwing. `@arki/failure` is now a dependency.

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/date@0.0.2
  - @arki/ui@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/date@1.0.0
  - @arki/ui@0.1.1
