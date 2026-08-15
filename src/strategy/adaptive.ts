import type { Strategy, PlanInput, MintPlan } from './index'

export interface AdaptiveConfig {
  /** Max ask bins (strictly above active) when two-sided. */
  binsAbove: number
  /** Max bid bins (strictly below active) when two-sided. */
  binsBelow: number
  /**
   * When one-sided (a cold-start pool with only one token — the common case is
   * base with no quote), concentrate into just this many nearest bins so the
   * first fills convert inventory fast at max fee density. Clamped to the
   * per-side max above.
   */
  coldStartBins: number
}

const ONE = 10n ** 18n

/**
 * Adaptive / inventory-following strategy.
 *
 * Two ideas, both aimed at thin pools where swapping to rebalance would bleed
 * fees:
 *
 *  1. **Inventory-following** — never forces a 50/50 split and never swaps.
 *     It mints exactly what's in the Safe: all X as asks above active, all Y as
 *     bids below active. When one side is empty it places purely one-sided and
 *     lets the pool convert inventory through fills (fee-POSITIVE) rather than
 *     paying a taker fee to swap.
 *
 *  2. **Near-active weighting** — liquidity is densest on the bin *nearest*
 *     active (the one that fills first) and tapers outward. On a one-sided
 *     cold-start it further tightens to `coldStartBins`, so the first trades
 *     convert base→quote quickly and at maximum fee density, getting the pool
 *     to two-sided as cheaply as possible.
 *
 * Repositioning is handled by the shared trigger (burn+remint = gas only, no
 * swap). This strategy only decides placement.
 */
export class AdaptiveStrategy implements Strategy {
  readonly id: Strategy['id'] = 'adaptive'

  constructor(private readonly cfg: AdaptiveConfig) {
    if (cfg.binsAbove < 0 || cfg.binsBelow < 0) throw new Error('binsAbove/binsBelow must be >= 0')
    if (cfg.binsAbove + cfg.binsBelow < 1) throw new Error('need at least one bin')
    if (cfg.coldStartBins < 1) throw new Error('coldStartBins must be >= 1')
  }

  plan(input: PlanInput): MintPlan {
    const { activeBin, xAvailable, yAvailable } = input
    const { binsAbove, binsBelow, coldStartBins } = this.cfg

    const haveX = xAvailable > 0n
    const haveY = yAvailable > 0n
    // Exactly one side present → cold-start: tighten to the nearest bins.
    const oneSided = haveX !== haveY

    const asksN = haveX ? (oneSided ? Math.min(coldStartBins, binsAbove) : binsAbove) : 0
    const bidsN = haveY ? (oneSided ? Math.min(coldStartBins, binsBelow) : binsBelow) : 0

    const binIds: number[] = []
    const distributionX: bigint[] = []
    const distributionY: bigint[] = []

    // Asks: active+1 (nearest, densest) … active+asksN (farthest).
    const wAsk = nearWeights(asksN)
    for (let d = 1; d <= asksN; d++) {
      binIds.push(activeBin + d)
      distributionX.push(wAsk[d - 1])
      distributionY.push(0n)
    }
    // Bids: active-1 (nearest, densest) … active-bidsN (farthest).
    const wBid = nearWeights(bidsN)
    for (let d = 1; d <= bidsN; d++) {
      binIds.push(activeBin - d)
      distributionX.push(0n)
      distributionY.push(wBid[d - 1])
    }

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: asksN > 0 ? xAvailable : 0n,
      amountY: bidsN > 0 ? yAvailable : 0n,
    }
  }

  /**
   * Recover the drift anchor (active bin at mint time) from held bins.
   *
   * Bins are laid out as asks [active+1 … active+N] and/or bids
   * [active-1 … active-M], so:
   *  - Two-sided: active is the internal gap (the single skipped bin) between
   *    the bid cluster and the ask cluster.
   *  - One-sided contiguous cluster: we can't read orientation from IDs alone.
   *    The dominant cold-start is base-only (asks), so we anchor to `min-1`.
   *    Worst case on a bid-only restart is one extra reposition — far cheaper
   *    than the permanent centroid drift that omitting this would cause.
   */
  anchorBin(binIds: number[]): number {
    if (binIds.length === 0) return 0
    const sorted = [...binIds].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i + 1] - sorted[i] > 1) return sorted[i] + 1
    }
    // Contiguous one-sided cluster → assume asks (base-only cold-start).
    return sorted[0] - 1
  }
}

/**
 * `n` weights that sum to exactly 1e18, linearly decreasing so index 0 (the bin
 * nearest active) is the densest. Rounding remainder is folded into index 0.
 */
function nearWeights(n: number): bigint[] {
  if (n <= 0) return []
  if (n === 1) return [ONE]
  let total = 0n
  const raw: bigint[] = []
  for (let i = 0; i < n; i++) {
    const w = BigInt(n - i) // n, n-1, …, 1  → densest nearest active
    raw.push(w)
    total += w
  }
  const dist = raw.map((w) => (w * ONE) / total)
  const sum = dist.reduce((a, b) => a + b, 0n)
  dist[0] += ONE - sum
  return dist
}
