# @arki/journal

## 0.1.0

### Minor Changes

- Initial public release. A journal for Drizzle entities: every change is an immutable event row, the current state is a normal table row, and both are written in one transaction. Inline projections run in the same transaction; effects run after commit from a job table. Subpaths: `@arki/journal`, `/pg`, `/errors`, `/dot`, `/orpc`, `/testing`.
