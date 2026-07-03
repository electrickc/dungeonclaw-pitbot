import type { Strategy, PlanInput, MintPlan } from './index'

export interface SpotConcentratedConfig {
  binCount: number
  binsAbove: number
  binsBelow: number
}

const ONE = 10n ** 18n

export class SpotConcentratedStrategy implements Strategy {
  readonly id: Strategy['id'] = 'spot-concentrated'

  constructor(private readonly cfg: SpotConcentratedConfig) {
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
      const filteredIds = binIds.filter((id) => id < activeBin)
      const yBins = filteredIds.length
      const per = ONE / BigInt(yBins)
      const distY: bigint[] = new Array(yBins).fill(per)
      distY[yBins - 1] += ONE - per * BigInt(yBins)
      return {
        binIds: filteredIds,
        distributionX: new Array(yBins).fill(0n),
        distributionY: distY,
        amountX: 0n,
        amountY: yAvailable,
      }
    }

    if (oneSidedX) {
      const filteredIds = binIds.filter((id) => id > activeBin)
      const xBins = filteredIds.length
      const per = ONE / BigInt(xBins)
      const distX: bigint[] = new Array(xBins).fill(per)
      distX[0] += ONE - per * BigInt(xBins)
      return {
        binIds: filteredIds,
        distributionX: distX,
        distributionY: new Array(xBins).fill(0n),
        amountX: xAvailable,
        amountY: 0n,
      }
    }

    // Two-sided uniform
    const xPer = ONE / BigInt(binsAbove)
    const yPer = ONE / BigInt(binsBelow)
    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = new Array(binCount).fill(0n)
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
    for (let i = 0; i < binCount; i++) {
      if (distributionX[i] > 0n) { distributionX[i] += ONE - sumX; break }
    }
    for (let i = binCount - 1; i >= 0; i--) {
      if (distributionY[i] > 0n) { distributionY[i] += ONE - sumY; break }
    }

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: sumX > 0n ? xAvailable : 0n,
      amountY: sumY > 0n ? yAvailable : 0n,
    }
  }
}
