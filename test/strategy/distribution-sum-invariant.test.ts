import { describe, it, expect } from 'vitest'
import { SpotSpreadStrategy } from '../../src/strategy/spot-spread'
import { SpotConcentratedStrategy } from '../../src/strategy/spot-concentrated'
import { CurveStrategy } from '../../src/strategy/curve'
import { BidAskStrategy } from '../../src/strategy/bid-ask'
import { WallStrategy } from '../../src/strategy/wall'
import type { Strategy } from '../../src/strategy'

const ONE = 10n ** 18n

/**
 * The on-chain JanusHelper.mintAtomic guard reverts unless each funded side's
 * distribution sums to EXACTLY 1e18 (AmountDistributionMismatch). If any
 * strategy emits a sum of 1e18 ± dust on any code path, the Safe's mint tx
 * reverts on-chain and the pool bricks. This property test sweeps activeBin,
 * bin layout, and available balances (including one-sided fallbacks) and
 * asserts the invariant for every funded side of every plan.
 */
function assertSums(strat: Strategy, activeBins: number[], amounts: bigint[]) {
  for (const activeBin of activeBins) {
    for (const x of amounts) {
      for (const y of amounts) {
        let plan
        try {
          plan = strat.plan({ activeBin, xAvailable: x, yAvailable: y, binStep: 20 })
        } catch {
          continue // strategies legitimately throw (e.g. wall with no Y)
        }
        const sumX = plan.distributionX.reduce((a, b) => a + b, 0n)
        const sumY = plan.distributionY.reduce((a, b) => a + b, 0n)
        if (plan.amountX > 0n) {
          expect(sumX, `${strat.id} sumX active=${activeBin} x=${x} y=${y}`).toBe(ONE)
        }
        if (plan.amountY > 0n) {
          expect(sumY, `${strat.id} sumY active=${activeBin} x=${x} y=${y}`).toBe(ONE)
        }
        // A funded side must never pair with a zero-sum distribution, and a
        // zero-sum side must never carry an amount (the stranding bug).
        if (sumX === 0n) expect(plan.amountX).toBe(0n)
        if (sumY === 0n) expect(plan.amountY).toBe(0n)
      }
    }
  }
}

const ACTIVE_BINS = [0, 1, 100, 8388608, 8388609]
// Includes dust amounts that trigger one-sided fallbacks and prime-ish values
// that stress the rounding-reconciliation code paths.
const AMOUNTS = [0n, 1n, 3n, 7n, 13n, 1000n, 1_000_000_000_000_000_000n, 123_456_789_987_654_321n]

describe('distribution sum invariant (matches on-chain 1e18 guard)', () => {
  it('spot-spread: every funded side sums to exactly 1e18', () => {
    assertSums(new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 }), ACTIVE_BINS, AMOUNTS)
    assertSums(new SpotSpreadStrategy({ binCount: 7, binsAbove: 3, binsBelow: 4 }), ACTIVE_BINS, AMOUNTS)
  })

  it('spot-concentrated: every funded side sums to exactly 1e18', () => {
    assertSums(new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 }), ACTIVE_BINS, AMOUNTS)
    assertSums(new SpotConcentratedStrategy({ binCount: 5, binsAbove: 2, binsBelow: 3 }), ACTIVE_BINS, AMOUNTS)
  })

  it('curve: every funded side sums to exactly 1e18', () => {
    assertSums(new CurveStrategy({ binCount: 10, binsAbove: 5, binsBelow: 5 }), ACTIVE_BINS, AMOUNTS)
    assertSums(new CurveStrategy({ binCount: 9, binsAbove: 4, binsBelow: 5 }), ACTIVE_BINS, AMOUNTS)
  })

  it('bid-ask: every funded side sums to exactly 1e18', () => {
    assertSums(new BidAskStrategy({ binCount: 12, binsAbove: 6, binsBelow: 6 }), ACTIVE_BINS, AMOUNTS)
    assertSums(new BidAskStrategy({ binCount: 7, binsAbove: 3, binsBelow: 4 }), ACTIVE_BINS, AMOUNTS)
  })

  it('wall: funded Y side sums to exactly 1e18', () => {
    assertSums(new WallStrategy({ binCount: 7, offsetFromActive: 1, skew: 'exponential' }), ACTIVE_BINS, AMOUNTS)
    assertSums(new WallStrategy({ binCount: 5, offsetFromActive: 3, skew: 'linear' }), ACTIVE_BINS, AMOUNTS)
  })
})
