/** A plain read: the pool-bound `repositories`, built once at boot. */
import type { Deps } from '../feature.js';

export const balance =
  ({ repositories }: Deps) =>
  (id: string) =>
    repositories.accounts.balance(id);
