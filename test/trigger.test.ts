import { describe, it, expect } from 'vitest'
import { decide } from '../src/trigger'

describe('trigger.decide', () => {
  it('returns place when no current position', () => {
    const r = decide({
      activeBin: 100,
      currentCenter: null,
      lastRebalanceTs: 0,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('place')
  })

  it('returns hold when within tolerance', () => {
    const r = decide({
      activeBin: 102,
      currentCenter: 100,
      lastRebalanceTs: 0,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 5,
    })
    expect(r.action).toBe('hold')
  })

  it('returns reposition when drift exceeds threshold and cooldown elapsed', () => {
    const r = decide({
      activeBin: 110,
      currentCenter: 100,
      lastRebalanceTs: 1,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('reposition')
  })

  it('returns hold when drift exceeds threshold but cooldown active', () => {
    const r = decide({
      activeBin: 110,
      currentCenter: 100,
      lastRebalanceTs: 990,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('hold')
  })

  it('returns withdraw_filled when any bin filled and cooldown elapsed', () => {
    const r = decide({
      activeBin: 100,
      currentCenter: 100,
      lastRebalanceTs: 1,
      nowTs: 1000,
      anyBinFilled: true,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('withdraw_filled')
  })

  describe('manipulation jump guard', () => {
    const base = {
      lastRebalanceTs: 1,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
      manipulationJumpBins: 10,
    }

    it('defers a reposition when the active bin jumped beyond the limit in one poll', () => {
      const r = decide({
        ...base,
        activeBin: 130,          // drift 30 > threshold 2 → would reposition…
        currentCenter: 100,
        lastObservedActiveBin: 100, // …but jumped 30 > 10 since last poll
      })
      expect(r.action).toBe('hold')
      expect(r.reason).toMatch(/manipulation guard/)
    })

    it('allows the reposition on the next poll once the move confirms (jump shrinks)', () => {
      const r = decide({
        ...base,
        activeBin: 130,
        currentCenter: 100,
        lastObservedActiveBin: 130, // price held at the new level → jump 0
      })
      expect(r.action).toBe('reposition')
    })

    it('defers an initial place on a suspicious jump', () => {
      const r = decide({
        ...base,
        activeBin: 130,
        currentCenter: null,
        lastObservedActiveBin: 100,
      })
      expect(r.action).toBe('hold')
      expect(r.reason).toMatch(/manipulation guard/)
    })

    it('does NOT defer withdraw_filled — fills are always safe to action', () => {
      const r = decide({
        ...base,
        activeBin: 130,
        currentCenter: 100,
        anyBinFilled: true,
        lastObservedActiveBin: 100, // big jump, but a real fill still withdraws
      })
      expect(r.action).toBe('withdraw_filled')
    })

    it('is inert on the first tick (no prior observation)', () => {
      const r = decide({
        ...base,
        activeBin: 130,
        currentCenter: 100,
        lastObservedActiveBin: null,
      })
      expect(r.action).toBe('reposition')
    })

    it('lets ordinary sub-limit drift through', () => {
      const r = decide({
        ...base,
        activeBin: 105,          // drift 5 > threshold 2, jump 5 < limit 10
        currentCenter: 100,
        lastObservedActiveBin: 100,
      })
      expect(r.action).toBe('reposition')
    })
  })
})
