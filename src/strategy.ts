import { config } from './config'

export interface WallPlan {
  binIds: number[]
  // Per-bin allocation in WETH wei. distributionY[i] = weiPerBin[i] / sum * 1e18
  weiPerBin: bigint[]
}

// Build the bid-wall layout: WALL_BIN_COUNT bins starting BIN_OFFSET_FROM_ACTIVE
// bins below the current active bin and extending further down.
// Skew: weights are heavier on bins further from active ("catch jeeters hard").
export function buildWallPlan(activeBin: number, totalWeth: bigint): WallPlan {
  const count = config.wallBinCount
  const startOffset = config.binOffsetFromActive

  // binIds: from (active - startOffset) down to (active - startOffset - count + 1)
  // index 0 is the shallowest, index count-1 is the deepest.
  const binIds: number[] = []
  for (let i = 0; i < count; i++) binIds.push(activeBin - startOffset - i)

  // Weights: deepest bin gets the largest share.
  // exponential: 1,2,4,8,16,32,64
  // linear:      1,2,3,4,5,6,7
  const weights: number[] = []
  for (let i = 0; i < count; i++) {
    if (config.skew === 'exponential') weights.push(2 ** i)
    else weights.push(i + 1)
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  // Allocate WETH. Last bin gets the remainder so rounding doesn't strand wei.
  const weiPerBin: bigint[] = []
  let assigned = 0n
  for (let i = 0; i < count - 1; i++) {
    const share = (totalWeth * BigInt(weights[i])) / BigInt(totalWeight)
    weiPerBin.push(share)
    assigned += share
  }
  weiPerBin.push(totalWeth - assigned)

  return { binIds, weiPerBin }
}

// distributionY for LB mint: each entry is wei share / total * 1e18,
// must sum to exactly 1e18. We compute exact fractions and put the remainder
// on the last bin so it sums clean.
export function distributionY(plan: WallPlan): bigint[] {
  const total = plan.weiPerBin.reduce((a, b) => a + b, 0n)
  if (total === 0n) throw new Error('Empty plan')
  const ONE = 10n ** 18n
  const dist: bigint[] = []
  let assigned = 0n
  for (let i = 0; i < plan.weiPerBin.length - 1; i++) {
    const d = (plan.weiPerBin[i] * ONE) / total
    dist.push(d)
    assigned += d
  }
  dist.push(ONE - assigned)
  return dist
}

// All-zero distributionX since we provide only WETH (tokenY).
export function distributionX(plan: WallPlan): bigint[] {
  return plan.binIds.map(() => 0n)
}

export interface RebalanceDecision {
  action: 'hold' | 'place' | 'reposition' | 'withdraw_filled'
  reason: string
}

export function decide(opts: {
  activeBin: number
  hasWall: boolean
  wallCenterBin: number | null
  lastRebalanceTs: number
  nowTs: number
  // Have any of our bins crossed below active (became DCLAW)?
  anyBinFilled: boolean
}): RebalanceDecision {
  // Cooldown gate (skip for kill / first-place)
  const cooldownExpired =
    opts.nowTs - opts.lastRebalanceTs >= config.rebalanceCooldownSeconds

  if (!opts.hasWall) {
    return { action: 'place', reason: 'no wall present' }
  }

  if (opts.anyBinFilled) {
    if (!cooldownExpired) {
      return { action: 'hold', reason: 'fill detected but cooldown active' }
    }
    return {
      action: 'withdraw_filled',
      reason: 'bin(s) filled — withdraw DCLAW and reset wall lower',
    }
  }

  if (opts.wallCenterBin === null) {
    return { action: 'hold', reason: 'wall present but center unknown — manual review' }
  }

  // Active drifted up — bigger green candle, bot needs to track up.
  const drift = opts.activeBin - opts.wallCenterBin
  // Our wall is centered roughly at (active - offset - (count-1)/2) at placement.
  // If active has run UP by > REBALANCE_BINS_THRESHOLD beyond expected,
  // reposition the wall to track.
  const expectedCenter = opts.wallCenterBin // last-place center; "active drifted up" means current active - expectedCenter > offset + (count-1)/2 + threshold
  const expectedDistance =
    config.binOffsetFromActive + Math.floor((config.wallBinCount - 1) / 2)
  if (drift - expectedDistance > config.rebalanceBinsThreshold) {
    if (!cooldownExpired) {
      return { action: 'hold', reason: 'price spiked up but cooldown active' }
    }
    return {
      action: 'reposition',
      reason: `price spiked up: active ${opts.activeBin} - wallCenter ${opts.wallCenterBin} = drift ${drift}, threshold exceeded`,
    }
  }

  return { action: 'hold', reason: 'within tolerance' }
}
