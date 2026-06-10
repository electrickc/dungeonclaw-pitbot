export interface DecideInput {
  activeBin: number
  currentCenter: number | null
  lastRebalanceTs: number
  nowTs: number
  anyBinFilled: boolean
  rebalanceCooldownSeconds: number
  rebalanceBinsThreshold: number
}

export interface DecideOutput {
  action: 'hold' | 'place' | 'reposition' | 'withdraw_filled'
  reason: string
}

export function decide(opts: DecideInput): DecideOutput {
  const cooldownExpired = opts.nowTs - opts.lastRebalanceTs >= opts.rebalanceCooldownSeconds

  if (opts.currentCenter === null) {
    return { action: 'place', reason: 'no position present' }
  }

  if (opts.anyBinFilled) {
    if (!cooldownExpired) return { action: 'hold', reason: 'fill detected but cooldown active' }
    return { action: 'withdraw_filled', reason: 'bin(s) filled — withdraw and reset' }
  }

  const drift = Math.abs(opts.activeBin - opts.currentCenter)
  if (drift > opts.rebalanceBinsThreshold) {
    if (!cooldownExpired) return { action: 'hold', reason: 'drift exceeds threshold but cooldown active' }
    return { action: 'reposition', reason: `drift ${drift} > threshold ${opts.rebalanceBinsThreshold}` }
  }

  return { action: 'hold', reason: 'within tolerance' }
}
