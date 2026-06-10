import { SpotSpreadStrategy } from './spot-spread'
import { SpotWideStrategy } from './spot-wide'
import { WallStrategy } from './wall'

export function buildStrategy(spec: {
  type: 'spot-spread' | 'spot-wide' | 'wall'
  knobs: Record<string, any>
}) {
  switch (spec.type) {
    case 'spot-spread':
      return new SpotSpreadStrategy({
        binCount: spec.knobs.binCount ?? 20,
        binsAbove: spec.knobs.binsAbove ?? 10,
        binsBelow: spec.knobs.binsBelow ?? 10,
      })
    case 'spot-wide':
      return new SpotWideStrategy({
        binCount: spec.knobs.binCount ?? 50,
        binsAbove: spec.knobs.binsAbove ?? 25,
        binsBelow: spec.knobs.binsBelow ?? 25,
      })
    case 'wall':
      return new WallStrategy({
        binCount: spec.knobs.binCount ?? 7,
        offsetFromActive: spec.knobs.offsetFromActive ?? 1,
        skew: spec.knobs.skew ?? 'exponential',
      })
  }
}
