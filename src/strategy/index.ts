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
}

/** Bots use the Strategy interface to decide what to mint. Pure functions. */
export interface Strategy {
  readonly id: 'spot-spread' | 'spot-wide' | 'wall'

  plan(input: PlanInput): MintPlan
}
