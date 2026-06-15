import { describe, it, expect } from 'vitest'
import { SpotConcentratedStrategy } from '../../src/strategy/spot-concentrated'

const ONE = 10n ** 18n
const ACTIVE = 8388608

describe('SpotConcentratedStrategy.plan', () => {
  it('two-sided: builds a 6-bin uniform shape with sums = 1e18 on each side', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    expect(plan.binIds).toHaveLength(6)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('two-sided: X bins are all above active, Y bins all below active', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    plan.binIds.forEach((id, i) => {
      if (plan.distributionX[i] > 0n) expect(id).toBeGreaterThan(ACTIVE)
      if (plan.distributionY[i] > 0n) expect(id).toBeLessThan(ACTIVE)
    })
  })

  it('Y-only fallback: when xAvailable too small, filters to below-active bins', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: 0n, yAvailable: ONE, binStep: 100,
    })
    expect(plan.binIds.every((id) => id < ACTIVE)).toBe(true)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('X-only fallback: when yAvailable too small, filters to above-active bins', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: 0n, binStep: 100,
    })
    expect(plan.binIds.every((id) => id > ACTIVE)).toBe(true)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('no phantom bins: every bin has X or Y weight > 0', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    plan.binIds.forEach((_, i) => {
      expect(plan.distributionX[i] > 0n || plan.distributionY[i] > 0n).toBe(true)
    })
  })

  it('rejects mismatched binCount / binsAbove + binsBelow', () => {
    expect(() => new SpotConcentratedStrategy({ binCount: 6, binsAbove: 4, binsBelow: 3 }))
      .toThrow(/binsAbove \+ binsBelow must equal binCount/)
  })
})
