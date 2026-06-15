import { describe, it, expect } from 'vitest'
import { BidAskStrategy } from '../../src/strategy/bid-ask'

const ONE = 10n ** 18n
const ACTIVE = 8388608

describe('BidAskStrategy.plan', () => {
  it('two-sided: builds a 20-bin U-shape with sums = 1e18 on each side', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1_000_000_000_000_000_000n,
      binStep: 100,
    })
    expect(plan.binIds).toHaveLength(20)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.amountX).toBe(1_000_000_000_000_000_000n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
  })

  it('two-sided: outermost bins receive more weight than innermost (U-shape)', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    // X bins are strictly above active. The bin furthest above active should have
    // the highest weight. The bin closest to active (just above) should have the
    // smallest X weight.
    const aboveX = plan.binIds
      .map((id, i) => ({ id, w: plan.distributionX[i] }))
      .filter((x) => x.id > ACTIVE)
      .sort((a, b) => a.id - b.id)
    expect(aboveX[aboveX.length - 1].w).toBeGreaterThan(aboveX[0].w)

    // Symmetric on Y side: bin furthest below has the highest weight.
    const belowY = plan.binIds
      .map((id, i) => ({ id, w: plan.distributionY[i] }))
      .filter((x) => x.id < ACTIVE)
      .sort((a, b) => a.id - b.id)
    expect(belowY[0].w).toBeGreaterThan(belowY[belowY.length - 1].w)
  })

  it('Y-only fallback: when xAvailable too small, filters to below-active bins', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: 0n,
      yAvailable: 1_000_000_000_000_000_000n,
      binStep: 100,
    })
    expect(plan.binIds.every((id) => id < ACTIVE)).toBe(true)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
  })

  it('X-only fallback: when yAvailable too small, filters to above-active bins', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 0n,
      binStep: 100,
    })
    expect(plan.binIds.every((id) => id > ACTIVE)).toBe(true)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('no phantom bins: every bin has X or Y weight > 0', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    plan.binIds.forEach((_, i) => {
      expect(plan.distributionX[i] > 0n || plan.distributionY[i] > 0n).toBe(true)
    })
  })

  it('every nonzero distribution value is at least 2% of ONE (LB v2 min-shares safety)', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    const MIN = ONE / 50n  // 2%
    plan.distributionX.filter((d) => d > 0n).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(MIN)
    })
    plan.distributionY.filter((d) => d > 0n).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(MIN)
    })
  })

  it('rejects mismatched binCount / binsAbove + binsBelow', () => {
    expect(() => new BidAskStrategy({ binCount: 20, binsAbove: 11, binsBelow: 10 }))
      .toThrow(/binsAbove \+ binsBelow must equal binCount/)
  })
})
