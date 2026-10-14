// jstat ships no types: declare only what math.bench.ts calls. It has to live in
// an ambient file, because a module file cannot augment an untyped package.
declare module 'jstat' {
  const jStat: {
    mean(values: readonly number[]): number;
    stdev(values: readonly number[], sample?: boolean): number;
    percentile(values: readonly number[], k: number, exclusive?: boolean): number;
    normal: { cdf(x: number, mean: number, sd: number): number; inv(p: number, mean: number, sd: number): number };
    studentt: { inv(p: number, df: number): number };
  };
  export default jStat;
}
