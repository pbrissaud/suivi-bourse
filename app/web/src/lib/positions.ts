import type { Share } from '@/lib/api'

/**
 * Narrow a share to a single account, or leave it whole.
 *
 * Written for the Titres page's account filter (#659) and moved here by #661,
 * which needs the same projection from the other direction: an account's sheet
 * lists that account's positions, and #652 déc. 13 says they come from
 * `/api/shares`'s per-account breakdown rather than from a new endpoint. One
 * query, two pages, one cache entry — and the narrowing rule in one place
 * instead of two.
 *
 * Note what this deliberately does *not* do: recompute a weighted mean. When one
 * account is selected there is nothing to weight — the API already returns that
 * account's own cost price in the breakdown — so the trap #655 called the
 * expensive half (`Σ(pp×pq)/Σpq`) stays in Python, with exactly one
 * implementation. Re-deriving it here in TypeScript is how it would drift.
 */
export function projectToAccount(share: Share, account: string | null): Share | null {
  if (account === null) return share
  const position = share.accounts.find((p) => p.account === account)
  if (!position) return null

  const unitGain =
    share.price !== null && position.cost_price !== null
      ? share.price - position.cost_price
      : null
  const pct =
    position.plus_value_latente !== null && position.invested
      ? position.plus_value_latente / position.invested
      : null

  return {
    ...share,
    owned_quantity: position.owned_quantity,
    purchased_quantity: position.purchased_quantity,
    cost_price: position.cost_price,
    purchased_fee: position.purchased_fee,
    received_dividend: position.received_dividend,
    market_value: position.market_value,
    invested: position.invested,
    plus_value_latente: position.plus_value_latente,
    plus_value_pct: pct,
    unit_gain: unitGain,
    accounts: [position],
  }
}
