// Algebrite ships no types: declare only what cas.bench.ts calls. It has to live
// in an ambient file, because a module file cannot augment an untyped package.
declare module 'algebrite' {
  const Algebrite: {
    /** Runs one Algebrite script and returns the printed result. */
    run(script: string): string;
  };
  export default Algebrite;
}
