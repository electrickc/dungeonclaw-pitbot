import { describe, it, expect } from 'vitest'
import { SpotSpreadStrategy } from '../../src/strategy/spot-spread'

describe('SpotSpreadStrategy.plan', () => {
  it('builds a 20-bin uniform shape centered on active when both assets present', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n, // 1 X
      yAvailable: 1_000_000_000_000_000_000n, // 1 Y
    })

    expect(plan.binIds).toHaveLength(20)
    // 10 bins below active should be distinct from 10 above
    const below = plan.binIds.filter((b) => b < 8388608)
    const above = plan.binIds.filter((b) => b > 8388608)
    expect(below).toHaveLength(10)
    expect(above).toHaveLength(10)

    // distributionX should be nonzero only on or above active bin
    const sumX = plan.distributionX.reduce((a, b) => a + b, 0n)
    const sumY = plan.distributionY.reduce((a, b) => a + b, 0n)
    expect(sumX).toBe(10n ** 18n)
    expect(sumY).toBe(10n ** 18n)

    expect(plan.amountX).toBe(1_000_000_000_000_000_000n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
  })

  it('one-sided Y when xAvailable is dust', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1n, // dust
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    // All Y must be at bins below active
    for (let i = 0; i < plan.binIds.length; i++) {
      if (plan.distributionY[i] > 0n) {
        expect(plan.binIds[i]).toBeLessThan(8388608)
      }
    }
  })
})
