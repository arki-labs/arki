// regression (regression-js) ships no types: declare only what math.bench.ts calls. It has to
// live in an ambient file, because a module file cannot augment an untyped package.
declare module 'regression' {
  type Point = readonly [number, number];
  type Options = { precision?: number; order?: number };
  type Result = { equation: number[]; r2: number };
  const regression: {
    linear(data: readonly Point[], options?: Options): Result;
    exponential(data: readonly Point[], options?: Options): Result;
    power(data: readonly Point[], options?: Options): Result;
    polynomial(data: readonly Point[], options?: Options): Result;
  };
  export default regression;
}
