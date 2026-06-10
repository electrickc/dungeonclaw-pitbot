import type { Strategy, PlanInput, MintPlan } from './index'

export interface WallConfig {
  binCount: number
  offsetFromActive: number
  skew: 'linear' | 'exponential'
}

const ONE = 10n ** 18n

export class WallStrategy implements Strategy {
  readonly id: Strategy['id'] = 'wall'

  constructor(private readonly cfg: WallConfig) {
    if (cfg.binCount < 1) throw new Error('binCount must be >= 1')
    if (cfg.offsetFromActive < 0) throw new Error('offsetFromActive must be >= 0')
  }

  plan(input: PlanInput): MintPlan {
    const { activeBin, yAvailable } = input
    const { binCount, offsetFromActive, skew } = this.cfg

    if (yAvailable === 0n) {
      throw new Error('wall strategy requires Y; no Y available')
    }

    const binIds: number[] = []
    for (let i = 0; i < binCount; i++) binIds.push(activeBin - offsetFromActive - i)

    const weights: bigint[] = []
    for (let i = 0; i < binCount; i++) {
      weights.push(skew === 'exponential' ? 1n << BigInt(i) : BigInt(i + 1))
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0n)

    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = []
    let sumY = 0n
    for (let i = 0; i < binCount - 1; i++) {
      const d = (weights[i] * ONE) / totalWeight
      distributionY.push(d)
      sumY += d
    }
    distributionY.push(ONE - sumY)

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: 0n,
      amountY: yAvailable,
    }
  }
}
