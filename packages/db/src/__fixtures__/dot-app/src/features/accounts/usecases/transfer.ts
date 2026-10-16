/** Transaction-aware: takes the scope per call, so its repositories are bound to that call's `tx`. */
import type { AccountsTx } from '../feature.js';

export type TransferInput = { readonly from: string; readonly to: string; readonly cents: number };

export async function transfer({ repos }: AccountsTx, input: TransferInput) {
  await repos.accounts.add(input.from, -input.cents);
  await repos.accounts.add(input.to, input.cents);
  // Reads through the same transaction see the writes above, before the commit.
  const from = await repos.accounts.balance(input.from);
  const to = await repos.accounts.balance(input.to);
  if (from === null || to === null) throw new Error('no such account');
  if (from < 0) throw new Error('insufficient funds');
  return { from, to };
}
