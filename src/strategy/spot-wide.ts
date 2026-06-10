import { SpotSpreadStrategy, SpotSpreadConfig } from './spot-spread'
import type { Strategy } from './index'

/**
 * Spot-Wide is structurally identical to Spot-Spread but with a wider default
 * bin count. It's a separate type so tier gating can distinguish it.
 */
export class SpotWideStrategy extends SpotSpreadStrategy implements Strategy {
  readonly id = 'spot-wide' as const

  constructor(cfg: SpotSpreadConfig) {
    super(cfg)
  }
}
