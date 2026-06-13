import { describe, it, expect } from 'vitest'
import { SpotSpreadStrategy } from '../../src/strategy/spot-spread'
import { buildStrategy } from '../../src/strategy'

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

  it('one-sided X when yAvailable is dust', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1n,
    })
    expect(plan.amountX).toBe(1_000_000_000_000_000_000n)
    expect(plan.amountY).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    for (let i = 0; i < plan.binIds.length; i++) {
      if (plan.distributionX[i] > 0n) {
        expect(plan.binIds[i]).toBeGreaterThan(8388608)
      }
    }
  })

  // LB v2.0 mint reverts when a bin in the ids array gets neither X nor Y
  // (a "phantom" bin). The earlier behavior of returning all 20 bins in the
  // one-sided branches was the v0.1.7 GS013 bug; one-sided plans must
  // contain ONLY the side actually receiving liquidity.
  it('one-sided X plan contains no phantom bins (only above-active)', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1n,
    })
    expect(plan.binIds.length).toBe(plan.distributionX.length)
    expect(plan.binIds.length).toBe(plan.distributionY.length)
    expect(plan.binIds.length).toBe(10)
    for (const id of plan.binIds) expect(id).toBeGreaterThan(8388608)
    // No phantom bin: every id must have a nonzero distribution
    for (let i = 0; i < plan.binIds.length; i++) {
      expect(plan.distributionX[i] + plan.distributionY[i]).toBeGreaterThan(0n)
    }
  })

  it('one-sided Y plan contains no phantom bins (only below-active)', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1n,
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.binIds.length).toBe(plan.distributionX.length)
    expect(plan.binIds.length).toBe(plan.distributionY.length)
    expect(plan.binIds.length).toBe(10)
    for (const id of plan.binIds) expect(id).toBeLessThan(8388608)
    for (let i = 0; i < plan.binIds.length; i++) {
      expect(plan.distributionX[i] + plan.distributionY[i]).toBeGreaterThan(0n)
    }
  })

  // Price-aware ratio: with active bin far below 2^23 (cheap X) and binStep 240,
  // 6.9M X tokens are worth ~5e-12 Y each — vastly less than 0.013 Y.
  // Raw-wei comparison would call this oneSidedX (X dominates by count). The
  // correct, price-aware answer is oneSidedY (Y dominates by value).
  it('value-aware: low-priced X with small high-priced Y is oneSidedY, not oneSidedX', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8387515, // ~1093 below center → price ~5e-12 Y/X
      binStep: 240,
      xAvailable: 6_900_000n * 10n ** 18n, // 6.9M X
      yAvailable: 13_000_000_000_000_000n, // 0.013 Y
    })
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(13_000_000_000_000_000n)
    for (const id of plan.binIds) expect(id).toBeLessThan(8387515)
  })
})

describe('buildStrategy', () => {
  it('builds Spot-Spread from spec', () => {
    const s = buildStrategy({ type: 'spot-spread', knobs: {} })
    expect(s.id).toBe('spot-spread')
  })
  it('builds Spot-Wide from spec', () => {
    const s = buildStrategy({ type: 'spot-wide', knobs: {} })
    expect(s.id).toBe('spot-wide')
  })
  it('builds Wall from spec', () => {
    const s = buildStrategy({ type: 'wall', knobs: {} })
    expect(s.id).toBe('wall')
  })
})
