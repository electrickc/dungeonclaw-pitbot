import type { Strategy, PlanInput, MintPlan } from './index'

export interface SpotSpreadConfig {
  binCount: number    // total bins; default 20
  binsAbove: number   // bins above active
  binsBelow: number   // bins below active
}

const ONE = 10n ** 18n

export class SpotSpreadStrategy implements Strategy {
  readonly id: Strategy['id'] = 'spot-spread'

  constructor(private readonly cfg: SpotSpreadConfig) {
    if (cfg.binsAbove + cfg.binsBelow !== cfg.binCount) {
      throw new Error('binsAbove + binsBelow must equal binCount')
    }
  }

  plan(input: PlanInput): MintPlan {
    const { activeBin, xAvailable, yAvailable } = input
    const { binCount, binsAbove, binsBelow } = this.cfg

    // One-sided fallback: if one side is <1% of total value, mint pure other side.
    const totalValue = xAvailable + yAvailable
    const xRatio = totalValue === 0n ? 0n : (xAvailable * 100n) / totalValue
    const yRatio = totalValue === 0n ? 0n : (yAvailable * 100n) / totalValue
    const oneSidedY = xRatio < 1n
    const oneSidedX = yRatio < 1n

    // Build bin id list: binsAbove bins strictly above active, then binsBelow bins strictly below.
    // Skip i=0 (the active bin itself) so we get exactly binsAbove + binsBelow = binCount entries.
    const binIds: number[] = []
    for (let i = binsAbove; i >= -binsBelow; i--) {
      if (i === 0) continue
      binIds.push(activeBin + i)
    }

    // Build distributions. X populated strictly above active. Y strictly below active.
    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = new Array(binCount).fill(0n)

    if (oneSidedY) {
      // Y-only: include ONLY bins below active. LBPair.mint reverts on
      // "phantom" bins (both distX and distY zero), so we must filter the
      // bin list down to just the side receiving liquidity.
      const filteredIds = binIds.filter((id) => id < activeBin)
      const yBins = filteredIds.length
      const per = ONE / BigInt(yBins)
      const distX: bigint[] = new Array(yBins).fill(0n)
      const distY: bigint[] = new Array(yBins).fill(per)
      distY[yBins - 1] += ONE - per * BigInt(yBins)
      return {
        binIds: filteredIds,
        distributionX: distX,
        distributionY: distY,
        amountX: 0n,
        amountY: yAvailable,
      }
    }

    if (oneSidedX) {
      // X-only: include ONLY bins above active (see oneSidedY note above).
      const filteredIds = binIds.filter((id) => id > activeBin)
      const xBins = filteredIds.length
      const per = ONE / BigInt(xBins)
      const distX: bigint[] = new Array(xBins).fill(per)
      const distY: bigint[] = new Array(xBins).fill(0n)
      distX[0] += ONE - per * BigInt(xBins)
      return {
        binIds: filteredIds,
        distributionX: distX,
        distributionY: distY,
        amountX: xAvailable,
        amountY: 0n,
      }
    }

    // Two-sided: Y goes below active, X goes above active.
    const xPer = ONE / BigInt(binsAbove)
    const yPer = ONE / BigInt(binsBelow)
    let sumX = 0n
    let sumY = 0n
    for (let i = 0; i < binCount; i++) {
      if (binIds[i] > activeBin) {
        distributionX[i] = xPer
        sumX += xPer
      } else if (binIds[i] < activeBin) {
        distributionY[i] = yPer
        sumY += yPer
      }
    }
    // Reconcile rounding into first X bin (highest above active)
    for (let i = 0; i < binCount; i++) {
      if (distributionX[i] > 0n) {
        distributionX[i] += ONE - sumX
        break
      }
    }
    // Reconcile rounding into last Y bin (closest below active)
    for (let i = binCount - 1; i >= 0; i--) {
      if (distributionY[i] > 0n) {
        distributionY[i] += ONE - sumY
        break
      }
    }

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: xAvailable,
      amountY: yAvailable,
    }
  }
}
