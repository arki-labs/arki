/** Runs `run` with readers bound to one snapshot transaction. Made by `snapshot()` (`@arki/live/drizzle`), used by `liveRead()` (`@arki/live/orpc`). */
export type SnapshotRunner<Readers> = <Result>(run: (readers: Readers) => Promise<Result>) => Promise<Result>;
