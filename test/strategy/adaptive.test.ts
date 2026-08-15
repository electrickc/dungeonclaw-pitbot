import { describe, it, expect } from 'vitest'
import { AdaptiveStrategy } from '../../src/strategy/adaptive'

const ONE = 10n ** 18n
const ACTIVE = 8388608

function make() {
  return new AdaptiveStrategy({ binsAbove: 5, binsBelow: 5, coldStartBins: 3 })
}

describe('AdaptiveStrategy.plan', () => {
  it('two-sided: X above active, Y below active, each side sums to 1e18', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100 })
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
    plan.binIds.forEach((id, i) => {
      if (plan.distributionX[i] > 0n) expect(id).toBeGreaterThan(ACTIVE)
      if (plan.distributionY[i] > 0n) expect(id).toBeLessThan(ACTIVE)
    })
    // amounts follow inventory
    expect(plan.amountX).toBe(ONE)
    expect(plan.amountY).toBe(ONE)
  })

  it('near-active weighting: the bin nearest active is the densest, tapering outward', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: ONE, yAvailable: 0n, binStep: 100 })
    // asks nearest-first: active+1 (index 0) must be > active+2 > …
    for (let i = 0; i < plan.distributionX.length - 1; i++) {
      expect(plan.distributionX[i]).toBeGreaterThan(plan.distributionX[i + 1])
    }
    // and the nearest bin is active+1
    expect(plan.binIds[0]).toBe(ACTIVE + 1)
  })

  it('cold-start (X-only): tightens to coldStartBins, all above active, sums to 1e18', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: ONE, yAvailable: 0n, binStep: 100 })
    expect(plan.binIds).toHaveLength(3) // coldStartBins, not binsAbove(5)
    expect(plan.binIds.every((id) => id > ACTIVE)).toBe(true)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.amountY).toBe(0n)
  })

  it('cold-start (Y-only): tightens to coldStartBins, all below active', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: 0n, yAvailable: ONE, binStep: 100 })
    expect(plan.binIds).toHaveLength(3)
    expect(plan.binIds.every((id) => id < ACTIVE)).toBe(true)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.amountX).toBe(0n)
  })

  it('no phantom bins: every bin carries X or Y weight', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100 })
    plan.binIds.forEach((_, i) => {
      expect(plan.distributionX[i] > 0n || plan.distributionY[i] > 0n).toBe(true)
    })
  })

  it('anchorBin: recovers active from a two-sided position (internal gap)', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100 })
    expect(make().anchorBin(plan.binIds)).toBe(ACTIVE)
  })

  it('anchorBin: recovers active from a one-sided ask cluster (min-1)', () => {
    const plan = make().plan({ activeBin: ACTIVE, xAvailable: ONE, yAvailable: 0n, binStep: 100 })
    expect(make().anchorBin(plan.binIds)).toBe(ACTIVE)
  })
})
