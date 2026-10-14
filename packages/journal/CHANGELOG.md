# @arki/journal

## 0.1.1

### Patch Changes

- Fix: `@arki/journal@0.1.0` could not be imported from npm. Its compiled code calls `getLogger` from `@arki/log`, but its manifest pinned `@arki/log@0.0.3`, which has no `getLogger`. This release depends on `@arki/log@0.1.0`, the version that has it.
- Updated dependencies [0685dfa]
- Updated dependencies
- Updated dependencies [2854df5]
  - @arki/dot@0.5.0
  - @arki/log@0.1.0

## 0.1.0

### Minor Changes

- Initial public release. A journal for Drizzle entities: every change is an immutable event row, the current state is a normal table row, and both are written in one transaction. Inline projections run in the same transaction; effects run after commit from a job table. Subpaths: `@arki/journal`, `/pg`, `/errors`, `/dot`, `/orpc`, `/testing`.
