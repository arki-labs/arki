/** `useAsyncMemo`: the result of an async function, recomputed when its dependencies change, with stale results dropped. A rejected promise becomes `failure`, and `retry()` runs the function again. */
import type { DependencyList } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

function sameDeps(previous: DependencyList, next: DependencyList) {
  return previous.length === next.length && next.every((dep, index) => Object.is(dep, previous[index]));
}

export type AsyncMemo<Value> = {
  /** The last resolved value, or `initial` until one resolves. A failed run keeps the previous value. */
  value: Value;
  /** True from the start of a run until it resolves or rejects. */
  isPending: boolean;
  /** The value the last run rejected with, or `undefined` when it did not reject. A new run clears it. */
  failure: unknown;
  /** Runs the function again with the same dependencies. */
  retry: () => void;
};

export function useAsyncMemo<T>(
  factory: () => Promise<T> | undefined | null,
  deps: DependencyList,
): AsyncMemo<T | undefined>;
export function useAsyncMemo<T>(
  factory: () => Promise<T> | undefined | null,
  deps: DependencyList,
  initial: T,
): AsyncMemo<T>;
export function useAsyncMemo<T>(
  factory: () => Promise<T> | undefined | null,
  deps: DependencyList,
  initial?: T,
): AsyncMemo<T | undefined> {
  const [value, setValue] = useState<T | undefined>(initial);
  const [isPending, setIsPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  // The caller owns the dependency list, as with useMemo: count a new run whenever it changes.
  const [seenDeps, setSeenDeps] = useState(deps);
  const [depsRun, setDepsRun] = useState(0);
  if (!sameDeps(seenDeps, deps)) {
    setSeenDeps(deps);
    setDepsRun(count => count + 1);
  }
  const latestFactory = useRef(factory);
  useLayoutEffect(() => {
    latestFactory.current = factory;
  });
  useEffect(() => {
    let cancel = false;
    const promise = latestFactory.current();
    if (promise === undefined || promise === null) return;
    // The effect starts external async work, so marking the run as started is part of syncing with it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsPending(true);
    setFailure(undefined);
    promise.then(
      resolved => {
        if (cancel) return;
        setValue(resolved);
        setIsPending(false);
      },
      (error: unknown) => {
        if (cancel) return;
        setFailure(error);
        setIsPending(false);
      },
    );
    return () => {
      cancel = true;
    };
  }, [depsRun, attempt]);
  const retry = useCallback(() => {
    setAttempt(count => count + 1);
  }, []);
  return { value, isPending, failure, retry };
}
