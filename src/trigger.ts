export interface DecideInput {
  activeBin: number
  currentCenter: number | null
  lastRebalanceTs: number
  nowTs: number
  anyBinFilled: boolean
  rebalanceCooldownSeconds: number
  rebalanceBinsThreshold: number
  // Center we minted around at the LAST rebalance (or initial place). Combined
  // with `rebalanceBinsThreshold` it enforces hysteresis — a fresh mint must
  // move the center by more than `threshold` bins from the previous mint, not
  // just from the activeBin. Without this, price oscillation around the
  // current center repeatedly burns + remints across the same boundary,
  // draining gas + LP fees. May be null for backward compatibility.
  lastRebalanceCenter?: number | null
}

export interface DecideOutput {
  action: 'hold' | 'place' | 'reposition' | 'withdraw_filled'
  reason: string
}

export function decide(opts: DecideInput): DecideOutput {
  // Clock-skew defense: if `nowTs` is somehow earlier than `lastRebalanceTs`
  // (NTP step backward, persisted future timestamp), treat as cooldown active.
  // The previous `nowTs - lastRebalanceTs >= cooldown` math would otherwise
  // produce a large negative on the left side and stay "not expired" anyway —
  // BUT if the bot then catches up to the future timestamp, the next true
  // comparison flips and lets a flurry of rebalances through. Force a fresh
  // cooldown window from the apparent backward step.
  const elapsed = opts.nowTs - opts.lastRebalanceTs
  const cooldownExpired = elapsed >= 0 && elapsed >= opts.rebalanceCooldownSeconds

  if (opts.currentCenter === null) {
    return { action: 'place', reason: 'no position present' }
  }

  if (opts.anyBinFilled) {
    if (!cooldownExpired) return { action: 'hold', reason: 'fill detected but cooldown active' }
    return { action: 'withdraw_filled', reason: 'bin(s) filled — withdraw and reset' }
  }

  const drift = Math.abs(opts.activeBin - opts.currentCenter)
  if (drift > opts.rebalanceBinsThreshold) {
    // Hysteresis check: don't rebalance if the new target center is within
    // `threshold` bins of the LAST rebalance center. This prevents a
    // ping-pong storm when price oscillates inside `[oldCenter ± threshold]`.
    if (opts.lastRebalanceCenter != null) {
      const moveFromLast = Math.abs(opts.activeBin - opts.lastRebalanceCenter)
      if (moveFromLast <= opts.rebalanceBinsThreshold) {
        return { action: 'hold', reason: `drift ${drift} > threshold but move from last rebalance ${moveFromLast} ≤ threshold (hysteresis)` }
      }
    }
    if (!cooldownExpired) return { action: 'hold', reason: 'drift exceeds threshold but cooldown active' }
    return { action: 'reposition', reason: `drift ${drift} > threshold ${opts.rebalanceBinsThreshold}` }
  }

  return { action: 'hold', reason: 'within tolerance' }
}
