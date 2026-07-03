import type { Strategy, PlanInput, MintPlan } from './index'

export interface BidAskConfig {
  binCount: number
  binsAbove: number
  binsBelow: number
}

const ONE = 10n ** 18n

// Floor that lifts the innermost-bin allocation above LB v2's effective
// min-shares-per-bin threshold (~1%). Without it, the natural (i+1)^2 weight
// drops the innermost bin to 0.26%, and LB v2's mint reverts (surfaces as
// Gnosis Safe GS013 from execTransaction).
const INNERMOST_BIAS = 10n

// U-shape weight: weight(i) = (distance_from_active + 1)^2 + INNERMOST_BIAS.
// Outer bins (high distance) get heavier weight than inner bins.
// The bias ensures the innermost bin clears LB v2's per-bin min-shares threshold.
function uShapeWeight(distanceFromActive: number): bigint {
  const d = BigInt(distanceFromActive + 1)
  return d * d + INNERMOST_BIAS
}

export class BidAskStrategy implements Strategy {
  readonly id: Strategy['id'] = 'bid-ask'

  constructor(private readonly cfg: BidAskConfig) {
    if (cfg.binsAbove + cfg.binsBelow !== cfg.binCount) {
      throw new Error('binsAbove + binsBelow must equal binCount')
    }
  }

  plan(input: PlanInput): MintPlan {
    const { activeBin, xAvailable, yAvailable } = input
    const { binCount, binsAbove, binsBelow } = this.cfg

    // Same intent-based one-sided check as spot-spread: if a side has fewer
    // wei than the bin count assigned to it, fall back to one-sided to avoid
    // LB v2.0's zero-shares revert.
    const oneSidedY = xAvailable < BigInt(binsAbove)
    const oneSidedX = yAvailable < BigInt(binsBelow)

    // Build bin id list: binsAbove bins strictly above active, then binsBelow strictly below.
    const binIds: number[] = []
    for (let i = binsAbove; i >= -binsBelow; i--) {
      if (i === 0) continue
      binIds.push(activeBin + i)
    }

    if (oneSidedY) {
      const filteredIds = binIds.filter((id) => id < activeBin).sort((a, b) => a - b)
      const weights = filteredIds.map((_, idx) => uShapeWeight(filteredIds.length - 1 - idx))
      const total = weights.reduce((a, b) => a + b, 0n)
      const dist: bigint[] = weights.map((w) => (w * ONE) / total)
      // Reconcile rounding into the outermost (furthest from active) bin = idx 0.
      const sum = dist.reduce((a, b) => a + b, 0n)
      dist[0] += ONE - sum
      return {
        binIds: filteredIds,
        distributionX: new Array(filteredIds.length).fill(0n),
        distributionY: dist,
        amountX: 0n,
        amountY: yAvailable,
      }
    }

    if (oneSidedX) {
      const filteredIds = binIds.filter((id) => id > activeBin).sort((a, b) => a - b)
      const weights = filteredIds.map((_, idx) => uShapeWeight(idx))
      const total = weights.reduce((a, b) => a + b, 0n)
      const dist: bigint[] = weights.map((w) => (w * ONE) / total)
      const sum = dist.reduce((a, b) => a + b, 0n)
      // Outermost above = last element of filteredIds (highest bin id).
      dist[dist.length - 1] += ONE - sum
      return {
        binIds: filteredIds,
        distributionX: dist,
        distributionY: new Array(filteredIds.length).fill(0n),
        amountX: xAvailable,
        amountY: 0n,
      }
    }

    // Two-sided: X above active, Y below active, both U-shaped (outer = heavier).
    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = new Array(binCount).fill(0n)

    // X side: binIds ordered descending from highest above active down to active+1.
    const xIndices: number[] = []
    binIds.forEach((id, i) => { if (id > activeBin) xIndices.push(i) })
    // Outermost above = highest bin id = first one we pushed (since binIds is descending).
    const xWeights = xIndices.map((_, k) => uShapeWeight(xIndices.length - 1 - k))
    const xTotal = xWeights.reduce((a, b) => a + b, 0n)
    let sumX = 0n
    xIndices.forEach((idx, k) => {
      const d = (xWeights[k] * ONE) / xTotal
      distributionX[idx] = d
      sumX += d
    })
    // Reconcile into outermost X (first in xIndices since descending list = outermost).
    distributionX[xIndices[0]] += ONE - sumX

    // Y side: binIds also includes below-active ones, ordered descending so the
    // lowest below-active bin is last in binIds.
    const yIndices: number[] = []
    binIds.forEach((id, i) => { if (id < activeBin) yIndices.push(i) })
    const yWeights = yIndices.map((_, k) => uShapeWeight(k))
    const yTotal = yWeights.reduce((a, b) => a + b, 0n)
    let sumY = 0n
    yIndices.forEach((idx, k) => {
      const d = (yWeights[k] * ONE) / yTotal
      distributionY[idx] = d
      sumY += d
    })
    // Reconcile into outermost Y = last index in yIndices (lowest bin id).
    distributionY[yIndices[yIndices.length - 1]] += ONE - sumY

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: sumX > 0n ? xAvailable : 0n,
      amountY: sumY > 0n ? yAvailable : 0n,
    }
  }
}
