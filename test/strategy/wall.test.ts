import { describe, it, expect } from 'vitest'
import { WallStrategy } from '../../src/strategy/wall'

describe('WallStrategy.plan', () => {
  it('builds an exponential-skew Y-only wall below active', () => {
    const strat = new WallStrategy({
      binCount: 7,
      offsetFromActive: 1,
      skew: 'exponential',
    })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 0n,
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.binIds).toHaveLength(7)
    expect(plan.binIds[0]).toBe(8388607)
    expect(plan.binIds[6]).toBe(8388601)
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    expect(plan.distributionY[6]).toBeGreaterThan(plan.distributionY[0])
  })

  it('builds a linear-skew wall', () => {
    const strat = new WallStrategy({
      binCount: 5,
      offsetFromActive: 2,
      skew: 'linear',
    })
    const plan = strat.plan({
      activeBin: 100,
      xAvailable: 0n,
      yAvailable: 5_000_000_000_000_000_000n,
    })
    expect(plan.binIds).toEqual([98, 97, 96, 95, 94])
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
  })

  it('rejects when only X is available (wall is Y-only)', () => {
    const strat = new WallStrategy({
      binCount: 7,
      offsetFromActive: 1,
      skew: 'exponential',
    })
    expect(() =>
      strat.plan({
        activeBin: 100,
        xAvailable: 1_000_000_000_000_000_000n,
        yAvailable: 0n,
      }),
    ).toThrow(/no Y available/)
  })

  // Regression: the wall centroid sits offset+binCount/2 below active, so using
  // it as the drift anchor made drift permanently exceed threshold, hot-looping
  // burn+remint every cooldown. anchorBin() must recover the activeBin the wall
  // was built around (highest bin + offset), yielding drift ≈ 0 right after a mint.
  it('anchorBin recovers the build-time activeBin, not the wall centroid', () => {
    const activeBin = 8388608
    const strat = new WallStrategy({
      binCount: 7,
      offsetFromActive: 3,
      skew: 'exponential',
    })
    const plan = strat.plan({ activeBin, xAvailable: 0n, yAvailable: 1_000_000_000_000_000_000n })

    const anchor = strat.anchorBin!(plan.binIds)
    expect(anchor).toBe(activeBin)

    // The centroid (old buggy anchor) would be far below active — prove the
    // fix actually moves the anchor back to active.
    const centroid = Math.round(plan.binIds.reduce((a, b) => a + b, 0) / plan.binIds.length)
    expect(activeBin - centroid).toBeGreaterThan(3) // offset(3) + ~binCount/2
    expect(Math.abs(activeBin - anchor)).toBe(0)     // fixed anchor: zero drift at mint
  })

  it('anchorBin returns 0 for an empty bin set', () => {
    const strat = new WallStrategy({ binCount: 5, offsetFromActive: 2, skew: 'linear' })
    expect(strat.anchorBin!([])).toBe(0)
  })
})
