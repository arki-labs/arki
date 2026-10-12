/**
 * Re-export of Emmett's `Decider` type, which represents the behaviour contract
 * of an event-sourced aggregate: `initialState`, `evolve`, and `decide`.
 *
 * Within this package we often refer to the same concept as an **aggregate**
 * to emphasise that it owns state and command handling. Stick to `Decider` when
 * interacting with upstream Emmett utilities, but feel free to adopt the
 * aggregate terminology in your own domain code for clarity.
 */
export { type Decider } from '@event-driven-io/emmett';
