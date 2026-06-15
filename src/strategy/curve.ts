import type { Strategy, PlanInput, MintPlan } from './index'

export interface CurveConfig {
  binCount: number
  binsAbove: number
  binsBelow: number
}

const ONE = 10n ** 18n

// Floor that lifts the outermost-bin allocation above LB v2's effective
// min-shares-per-bin threshold (~1%). Without it, the linear taper drops
// the outermost bin to 1.82%, sitting on LB v2's revert boundary.
const OUTERMOST_BIAS = 3n

// Bell-shape weight: linear taper. Bin closest to active gets weight `binsSide`,
// furthest gets weight 1. weight(0) = binsSide, weight(binsSide - 1) = 1.
// OUTERMOST_BIAS is added to every bin so the outermost always clears 2% of ONE.
function bellWeight(distanceFromActive: number, binsSide: number): bigint {
  const w = binsSide - distanceFromActive
  return (w >= 1 ? BigInt(w) : 1n) + OUTERMOST_BIAS
}

export class CurveStrategy implements Strategy {
  readonly id: Strategy['id'] = 'curve'

  constructor(private readonly cfg: CurveConfig) {
    if (cfg.binsAbove + cfg.binsBelow !== cfg.binCount) {
      throw new Error('binsAbove + binsBelow must equal binCount')
    }
  }

  plan(input: PlanInput): MintPlan {
    const { activeBin, xAvailable, yAvailable } = input
    const { binCount, binsAbove, binsBelow } = this.cfg

    const oneSidedY = xAvailable < BigInt(binsAbove)
    const oneSidedX = yAvailable < BigInt(binsBelow)

    const binIds: number[] = []
    for (let i = binsAbove; i >= -binsBelow; i--) {
      if (i === 0) continue
      binIds.push(activeBin + i)
    }

    if (oneSidedY) {
      const filteredIds = binIds.filter((id) => id < activeBin).sort((a, b) => a - b)
      // distance-from-active for below-active bins increases as bin id decreases.
      // filteredIds is ascending, so the LAST element is closest to active (distance 0),
      // the FIRST is furthest (distance = filteredIds.length - 1).
      const weights = filteredIds.map((_, idx) => bellWeight(filteredIds.length - 1 - idx, filteredIds.length))
      const total = weights.reduce((a, b) => a + b, 0n)
      const dist: bigint[] = weights.map((w) => (w * ONE) / total)
      const sum = dist.reduce((a, b) => a + b, 0n)
      // Reconcile into innermost (closest to active) = last index in ascending list.
      dist[dist.length - 1] += ONE - sum
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
      // filteredIds ascending. First element is closest to active (distance 0),
      // last is furthest.
      const weights = filteredIds.map((_, idx) => bellWeight(idx, filteredIds.length))
      const total = weights.reduce((a, b) => a + b, 0n)
      const dist: bigint[] = weights.map((w) => (w * ONE) / total)
      const sum = dist.reduce((a, b) => a + b, 0n)
      // Reconcile into innermost = first index.
      dist[0] += ONE - sum
      return {
        binIds: filteredIds,
        distributionX: dist,
        distributionY: new Array(filteredIds.length).fill(0n),
        amountX: xAvailable,
        amountY: 0n,
      }
    }

    // Two-sided
    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = new Array(binCount).fill(0n)

    const xIndices: number[] = []
    binIds.forEach((id, i) => { if (id > activeBin) xIndices.push(i) })
    // xIndices ordered descending by bin id (because binIds is descending). So the
    // FIRST in xIndices is the highest bin id (furthest above active), the LAST is
    // closest to active. Distance increases from end to start.
    const xWeights = xIndices.map((_, k) => bellWeight(xIndices.length - 1 - k, xIndices.length))
    const xTotal = xWeights.reduce((a, b) => a + b, 0n)
    let sumX = 0n
    xIndices.forEach((idx, k) => {
      const d = (xWeights[k] * ONE) / xTotal
      distributionX[idx] = d
      sumX += d
    })
    // Innermost above active = LAST in xIndices (closest to active).
    distributionX[xIndices[xIndices.length - 1]] += ONE - sumX

    const yIndices: number[] = []
    binIds.forEach((id, i) => { if (id < activeBin) yIndices.push(i) })
    // yIndices also descending by bin id. FIRST = closest to active (highest below-active id),
    // LAST = furthest (lowest id).
    const yWeights = yIndices.map((_, k) => bellWeight(k, yIndices.length))
    const yTotal = yWeights.reduce((a, b) => a + b, 0n)
    let sumY = 0n
    yIndices.forEach((idx, k) => {
      const d = (yWeights[k] * ONE) / yTotal
      distributionY[idx] = d
      sumY += d
    })
    // Innermost below active = FIRST in yIndices.
    distributionY[yIndices[0]] += ONE - sumY

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: xAvailable,
      amountY: yAvailable,
    }
  }
}
