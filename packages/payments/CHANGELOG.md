# @arki/payments

## 0.2.0

### Minor Changes

- First public release. The package now compiles to `dist/` and owns its user id: `UserId`, `userIdSchema` and `userIdFactory` come from `@arki/payments/core` instead of `@arki/auth`, with the same `usr_` shape, so apps on `@arki/auth` pass their ids through unchanged and the package no longer depends on `@arki/auth`.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2
  - @arki/env@0.0.3
  - @arki/db@0.1.2
  - @arki/kv@0.1.2
  - @arki/event-sourcing@0.1.2
  - @arki/auth@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/env@0.0.2
  - @arki/kv@0.1.1
  - @arki/db@0.1.1
  - @arki/event-sourcing@0.1.1
  - @arki/auth@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/log@1.0.0
  - @arki/db@0.1.1
  - @arki/auth@0.1.1
  - @arki/event-sourcing@0.1.1
  - @arki/kv@0.1.1
