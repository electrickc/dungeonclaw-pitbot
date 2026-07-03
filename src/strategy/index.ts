/** Plan for a single mint operation: which bins + how to distribute. */
export interface MintPlan {
  /** LB bin IDs to mint into (must each pass the helper's drift check). */
  binIds: number[]
  /** Per-bin X distribution; entries sum to 0 or 1e18 (one-sided allowed). */
  distributionX: bigint[]
  /** Per-bin Y distribution; entries sum to 0 or 1e18. */
  distributionY: bigint[]
  /** X amount to pull from the Safe and forward to the pair. */
  amountX: bigint
  /** Y amount to pull from the Safe and forward to the pair. */
  amountY: bigint
}

/** Snapshot data the strategy needs to plan. */
export interface PlanInput {
  activeBin: number
  xAvailable: bigint
  yAvailable: bigint
  /** LB v2.0 bin step (basis points). Needed for price-aware ratio decisions. */
  binStep: number
}

/** Bots use the Strategy interface to decide what to mint. Pure functions. */
export interface Strategy {
  readonly id: 'spot-spread' | 'spot-wide' | 'wall' | 'spot-concentrated' | 'curve' | 'bid-ask'

  plan(input: PlanInput): MintPlan

  /**
   * Recover the drift anchor (the activeBin the position was built around)
   * from a set of held bin IDs. Used ONLY on restart, when the in-memory
   * anchor is lost and we must reconstruct it from on-chain positions.
   *
   * Drift is measured as |activeBin - anchor|. The anchor is the activeBin at
   * mint time, NOT the geometric centroid of the bins — for asymmetric shapes
   * (wall, bid-ask) the centroid is deliberately offset from active, so using
   * it as the anchor makes drift permanently exceed threshold and hot-loops
   * rebalance. Symmetric strategies may omit this; the caller falls back to the
   * share-weighted centroid, which equals the anchor for symmetric layouts.
   */
  anchorBin?(binIds: number[]): number
}

export { buildStrategy } from './factory'
