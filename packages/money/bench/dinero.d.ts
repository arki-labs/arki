// dinero.js v1 ships no types: declare only what money.bench.ts calls. It has to
// live in an ambient file, because a module file cannot augment an untyped package.
declare module 'dinero.js' {
  type RoundingMode = 'HALF_ODD' | 'HALF_EVEN' | 'HALF_UP' | 'HALF_DOWN' | 'HALF_TOWARDS_ZERO' | 'HALF_AWAY_FROM_ZERO';
  type DineroObject = {
    getAmount(): number;
    add(other: DineroObject): DineroObject;
    multiply(multiplier: number, roundingMode?: RoundingMode): DineroObject;
    allocate(ratios: readonly number[]): DineroObject[];
    lessThan(other: DineroObject): boolean;
    equalsTo(other: DineroObject): boolean;
    toFormat(format?: string, roundingMode?: RoundingMode): string;
  };
  function Dinero(options: { amount: number; currency?: string; precision?: number }): DineroObject;
  export default Dinero;
}
