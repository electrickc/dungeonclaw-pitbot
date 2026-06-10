import { describe, it, expect } from 'vitest'
import { SpotWideStrategy } from '../../src/strategy/spot-wide'

describe('SpotWideStrategy', () => {
  it('defaults to ~50 bins', () => {
    const strat = new SpotWideStrategy({ binCount: 50, binsAbove: 25, binsBelow: 25 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.binIds).toHaveLength(50)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
  })

  it('reports its strategy id', () => {
    const strat = new SpotWideStrategy({ binCount: 50, binsAbove: 25, binsBelow: 25 })
    expect(strat.id).toBe('spot-wide')
  })
})
