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

describe('trigger.decide — edge-based rebalance (deployed range)', () => {
  const base = {
    currentCenter: 100,
    lastRebalanceTs: 1,
    nowTs: 100000,             // far past cooldown by default
    anyBinFilled: false,
    rebalanceCooldownSeconds: 60,
    rebalanceBinsThreshold: 2, // small legacy threshold — MUST be ignored when a range is present
    heldMinBin: 90,
    heldMaxBin: 110,
  }

  it('HOLDS while spot is inside the deployed range, even well past the legacy % threshold', () => {
    // drift 8 ≫ legacy threshold 2, but still inside [90,110] → no rebalance
    expect(decide({ ...base, activeBin: 108 }).action).toBe('hold')
  })

  it('HOLDS exactly at the edge bin (not yet past it)', () => {
    expect(decide({ ...base, activeBin: 110 }).action).toBe('hold')
    expect(decide({ ...base, activeBin: 90 }).action).toBe('hold')
  })

  it('REPOSITIONS one bin past the upper edge', () => {
    expect(decide({ ...base, activeBin: 111 }).action).toBe('reposition')
  })

  it('REPOSITIONS one bin past the lower edge', () => {
    expect(decide({ ...base, activeBin: 89 }).action).toBe('reposition')
  })

  it('HOLDS when spot exited the range but cooldown is still active', () => {
    expect(decide({ ...base, activeBin: 120, lastRebalanceTs: 99990 }).action).toBe('hold')
  })

  it('defers reposition when exited but active jumped suspiciously this poll', () => {
    expect(decide({ ...base, activeBin: 130, lastObservedActiveBin: 100, manipulationJumpBins: 10 }).action).toBe('hold')
  })
})
