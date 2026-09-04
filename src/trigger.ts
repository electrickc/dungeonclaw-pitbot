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
  // Active bin observed on the PREVIOUS tick. Used by the sudden-jump
  // manipulation guard to measure how far price moved in one poll interval.
  // null on the first tick (no prior observation → guard is inert).
  lastObservedActiveBin?: number | null
  // Max bins the active bin may move in a single poll before a capital-
  // committing mint is deferred one tick to confirm the move is real. Computed
  // per-pair from a price-% threshold and the pair's binStep so it means the
  // same thing on every market regardless of bin width. Defaults to Infinity
  // (guard off) when omitted, preserving legacy callers.
  manipulationJumpBins?: number
  // The bot's CURRENT deployed bin range (min/max HELD bin ids). When present,
  // the rebalance trigger is EDGE-BASED: reposition only once the active (spot)
  // bin leaves this range — i.e. one bin past the last edge bin — instead of on
  // a small %-of-price drift from center. Far less aggressive: liquidity is only
  // moved when price actually exits the bins we're providing, saving gas + LP
  // churn during normal in-range oscillation. Null/omitted (no position, or
  // price already outside the scan window) → falls back to the legacy
  // center-drift threshold below.
  heldMinBin?: number | null
  heldMaxBin?: number | null
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

  // Sudden-jump manipulation guard. If the active bin moved more than
  // `manipulationJumpBins` since the last poll, defer any capital-committing
  // mint (place or reposition) by one tick. Rationale: a flash-loan price shove
  // is atomic — it reverts in the same block, long before our next ~30s poll,
  // so we never even see it. To actually move our liquidity an attacker must
  // HOLD the manipulation across polls with real capital, which is costly and
  // self-arbitraging. Deferring one tick means a genuine sharp move simply
  // confirms next poll (jump shrinks to ~0 once price settles) and proceeds,
  // while a transient spike is gone by the next tick and never triggers a mint.
  // Fills (withdraw_filled) are composition-based and always safe to action, so
  // they intentionally bypass this guard. Omitted field ⇒ Infinity ⇒ inert.
  const jumpLimit = opts.manipulationJumpBins ?? Infinity
  const jump = opts.lastObservedActiveBin == null
    ? 0
    : Math.abs(opts.activeBin - opts.lastObservedActiveBin)
  const suspiciousJump = jump > jumpLimit

  if (opts.currentCenter === null) {
    if (suspiciousJump) {
      return { action: 'hold', reason: `active jumped ${jump} > ${jumpLimit} bins this poll — deferring initial place to confirm (manipulation guard)` }
    }
    return { action: 'place', reason: 'no position present' }
  }

  if (opts.anyBinFilled) {
    if (!cooldownExpired) return { action: 'hold', reason: 'fill detected but cooldown active' }
    return { action: 'withdraw_filled', reason: 'bin(s) filled — withdraw and reset' }
  }

  // ── Rebalance trigger ──────────────────────────────────────────────────
  // PREFERRED: edge-based. Reposition only once the active (spot) bin exits the
  // deployed range — one bin past the last edge bin. Rebalancing re-centers the
  // range on the new active bin, so hysteresis is inherent (price must traverse
  // a full half-width again before it can re-trigger — no ping-pong).
  const haveRange = opts.heldMinBin != null && opts.heldMaxBin != null
  const exitedRange = haveRange &&
    (opts.activeBin < (opts.heldMinBin as number) || opts.activeBin > (opts.heldMaxBin as number))

  // FALLBACK (range unknown — e.g. no positions in scan window): the legacy
  // center-drift threshold, with ping-pong hysteresis against the last center.
  const drift = Math.abs(opts.activeBin - opts.currentCenter)
  const driftExceeded = !haveRange && drift > opts.rebalanceBinsThreshold

  if (exitedRange || driftExceeded) {
    if (driftExceeded && opts.lastRebalanceCenter != null) {
      const moveFromLast = Math.abs(opts.activeBin - opts.lastRebalanceCenter)
      if (moveFromLast <= opts.rebalanceBinsThreshold) {
        return { action: 'hold', reason: `drift ${drift} > threshold but move from last rebalance ${moveFromLast} ≤ threshold (hysteresis)` }
      }
    }
    if (suspiciousJump) {
      return { action: 'hold', reason: `price left range but active jumped ${jump} > ${jumpLimit} bins this poll — deferring reposition to confirm (manipulation guard)` }
    }
    if (!cooldownExpired) return { action: 'hold', reason: 'price left deployed range but cooldown active' }
    const why = exitedRange
      ? `spot bin ${opts.activeBin} left deployed range [${opts.heldMinBin}, ${opts.heldMaxBin}] — rebalance`
      : `drift ${drift} > threshold ${opts.rebalanceBinsThreshold}`
    return { action: 'reposition', reason: why }
  }

  return {
    action: 'hold',
    reason: haveRange
      ? `spot bin ${opts.activeBin} within deployed range [${opts.heldMinBin}, ${opts.heldMaxBin}]`
      : 'within tolerance',
  }
}
