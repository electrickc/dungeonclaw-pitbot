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
})
