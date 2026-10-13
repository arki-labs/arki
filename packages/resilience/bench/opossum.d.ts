// opossum ships no types and there is no @types/opossum here: declare only what the suite calls.
declare module 'opossum' {
  export default class CircuitBreaker<Args extends unknown[], Result> {
    constructor(action: (...args: Args) => Promise<Result>, options?: Record<string, unknown>);
    fire(...args: Args): Promise<Result>;
  }
}
