# Advanced Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 3 missing pitbot strategies (`bid-ask`, `curve`, `spot-concentrated`) following the existing wall/spot-spread pattern, plus factory wiring, image bump to `v0.1.12`, and a rolling VM upgrade so ADVANCED-tier pools can actually use these shapes.

**Architecture:** Three new strategy files in `src/strategy/`, each implementing the existing `Strategy` interface with hard-coded distribution math (no new knobs). The `factory.ts` switch gains three cases and the `spec.type` union widens to all six names. Bot version bumps `0.1.11` → `0.1.12`. Janus-app's provision route inlines `v0.1.12`. Existing VMs upgrade via `secretvm-cli vm edit` (preserves `wallet.key` + `state.json`).

**Tech Stack:** TypeScript, ethers v6.13, vitest 4.x, Docker.

**Spec:** `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/docs/superpowers/specs/2026-06-15-advanced-strategies-design.md`

---

## File Map

| File | Created / Modified | Responsibility |
|---|---|---|
| `src/strategy/index.ts` | Modified | Widen `Strategy.id` union to all 6 names |
| `src/strategy/bid-ask.ts` | Created | U-shape distribution (capital at outer bins) |
| `src/strategy/curve.ts` | Created | Bell-shape distribution (capital concentrated near active) |
| `src/strategy/spot-concentrated.ts` | Created | Tight uniform spread with narrow defaults |
| `src/strategy/factory.ts` | Modified | Three new switch cases + union widening |
| `test/strategy/bid-ask.test.ts` | Created | 6 tests for bid-ask |
| `test/strategy/curve.test.ts` | Created | 6 tests for curve |
| `test/strategy/spot-concentrated.test.ts` | Created | 6 tests for spot-concentrated |
| `package.json` | Modified | Version bump 0.1.11 → 0.1.12 |
| `janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` | Modified | Inline YAML bumped to v0.1.12 |

---

## Task 1: Widen Strategy.id union + branch setup

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/index.ts`

- [ ] **Step 0: Create branch**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git checkout main
git checkout -b feat/advanced-strategies
```

Expected: switched to `feat/advanced-strategies`.

- [ ] **Step 1: Widen the union**

Open `src/strategy/index.ts`. Change line 26:

```ts
// Before:
  readonly id: 'spot-spread' | 'spot-wide' | 'wall'

// After:
  readonly id: 'spot-spread' | 'spot-wide' | 'wall' | 'spot-concentrated' | 'curve' | 'bid-ask'
```

No other changes.

- [ ] **Step 2: Confirm existing tests still pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npm test
```

Expected: all existing tests pass; we only widened the union (no narrowing).

- [ ] **Step 3: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/index.ts
git commit -m "strategy: widen Strategy.id union to include 3 advanced shapes"
```

---

## Task 2: Implement bid-ask + tests

**Files:**
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/bid-ask.ts`
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/strategy/bid-ask.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/strategy/bid-ask.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BidAskStrategy } from '../../src/strategy/bid-ask'

const ONE = 10n ** 18n
const ACTIVE = 8388608

describe('BidAskStrategy.plan', () => {
  it('two-sided: builds a 20-bin U-shape with sums = 1e18 on each side', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1_000_000_000_000_000_000n,
      binStep: 100,
    })
    expect(plan.binIds).toHaveLength(20)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.amountX).toBe(1_000_000_000_000_000_000n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
  })

  it('two-sided: outermost bins receive more weight than innermost (U-shape)', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    // X bins are strictly above active. The bin furthest above active should have
    // the highest weight. The bin closest to active (just above) should have the
    // smallest X weight.
    const aboveX = plan.binIds
      .map((id, i) => ({ id, w: plan.distributionX[i] }))
      .filter((x) => x.id > ACTIVE)
      .sort((a, b) => a.id - b.id)
    expect(aboveX[aboveX.length - 1].w).toBeGreaterThan(aboveX[0].w)

    // Symmetric on Y side: bin furthest below has the highest weight.
    const belowY = plan.binIds
      .map((id, i) => ({ id, w: plan.distributionY[i] }))
      .filter((x) => x.id < ACTIVE)
      .sort((a, b) => a.id - b.id)
    expect(belowY[0].w).toBeGreaterThan(belowY[belowY.length - 1].w)
  })

  it('Y-only fallback: when xAvailable too small, filters to below-active bins', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: 0n,
      yAvailable: 1_000_000_000_000_000_000n,
      binStep: 100,
    })
    expect(plan.binIds.every((id) => id < ACTIVE)).toBe(true)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
  })

  it('X-only fallback: when yAvailable too small, filters to above-active bins', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 0n,
      binStep: 100,
    })
    expect(plan.binIds.every((id) => id > ACTIVE)).toBe(true)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('no phantom bins: every bin has X or Y weight > 0', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    plan.binIds.forEach((_, i) => {
      expect(plan.distributionX[i] > 0n || plan.distributionY[i] > 0n).toBe(true)
    })
  })

  it('rejects mismatched binCount / binsAbove + binsBelow', () => {
    expect(() => new BidAskStrategy({ binCount: 20, binsAbove: 11, binsBelow: 10 }))
      .toThrow(/binsAbove \+ binsBelow must equal binCount/)
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/bid-ask.test.ts
```

Expected: 6 fail — "Cannot find module '../../src/strategy/bid-ask'".

- [ ] **Step 3: Implement bid-ask.ts**

Create `src/strategy/bid-ask.ts`:

```ts
import type { Strategy, PlanInput, MintPlan } from './index'

export interface BidAskConfig {
  binCount: number
  binsAbove: number
  binsBelow: number
}

const ONE = 10n ** 18n

// U-shape weight: weight(i) = (distance_from_active + 1)^2.
// Outer bins (high distance) get heavier weight than inner bins.
function uShapeWeight(distanceFromActive: number): bigint {
  const d = BigInt(distanceFromActive + 1)
  return d * d
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
    // Reconcile into outermost X (last in xIndices since descending list = first idx = outermost).
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
      amountX: xAvailable,
      amountY: yAvailable,
    }
  }
}
```

- [ ] **Step 4: Confirm pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/bid-ask.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/bid-ask.ts test/strategy/bid-ask.test.ts
git commit -m "strategy: bid-ask U-shape with intent-based one-sided fallback"
```

---

## Task 3: Implement curve + tests

**Files:**
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/curve.ts`
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/strategy/curve.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/strategy/curve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CurveStrategy } from '../../src/strategy/curve'

const ONE = 10n ** 18n
const ACTIVE = 8388608

describe('CurveStrategy.plan', () => {
  it('two-sided: builds a 20-bin bell shape with sums = 1e18 on each side', () => {
    const strat = new CurveStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    expect(plan.binIds).toHaveLength(20)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('two-sided: innermost bins receive more weight than outermost (bell shape)', () => {
    const strat = new CurveStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    // X side: bin closest to active (lowest id above active) should have the
    // highest weight; furthest should have the lowest.
    const aboveX = plan.binIds
      .map((id, i) => ({ id, w: plan.distributionX[i] }))
      .filter((x) => x.id > ACTIVE)
      .sort((a, b) => a.id - b.id)
    expect(aboveX[0].w).toBeGreaterThan(aboveX[aboveX.length - 1].w)

    // Y side: bin closest to active (highest id below active) should have the
    // highest weight.
    const belowY = plan.binIds
      .map((id, i) => ({ id, w: plan.distributionY[i] }))
      .filter((x) => x.id < ACTIVE)
      .sort((a, b) => a.id - b.id)
    expect(belowY[belowY.length - 1].w).toBeGreaterThan(belowY[0].w)
  })

  it('Y-only fallback: when xAvailable too small, filters to below-active bins', () => {
    const strat = new CurveStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: 0n, yAvailable: ONE, binStep: 100,
    })
    expect(plan.binIds.every((id) => id < ACTIVE)).toBe(true)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('X-only fallback: when yAvailable too small, filters to above-active bins', () => {
    const strat = new CurveStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: 0n, binStep: 100,
    })
    expect(plan.binIds.every((id) => id > ACTIVE)).toBe(true)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('no phantom bins: every bin has X or Y weight > 0', () => {
    const strat = new CurveStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    plan.binIds.forEach((_, i) => {
      expect(plan.distributionX[i] > 0n || plan.distributionY[i] > 0n).toBe(true)
    })
  })

  it('rejects mismatched binCount / binsAbove + binsBelow', () => {
    expect(() => new CurveStrategy({ binCount: 20, binsAbove: 5, binsBelow: 10 }))
      .toThrow(/binsAbove \+ binsBelow must equal binCount/)
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/curve.test.ts
```

Expected: 6 fail — module-not-found.

- [ ] **Step 3: Implement curve.ts**

Create `src/strategy/curve.ts`:

```ts
import type { Strategy, PlanInput, MintPlan } from './index'

export interface CurveConfig {
  binCount: number
  binsAbove: number
  binsBelow: number
}

const ONE = 10n ** 18n

// Bell-shape weight: linear taper. Bin closest to active gets weight `binsSide`,
// furthest gets weight 1. weight(0) = binsSide, weight(binsSide - 1) = 1.
function bellWeight(distanceFromActive: number, binsSide: number): bigint {
  const w = binsSide - distanceFromActive
  return w >= 1 ? BigInt(w) : 1n
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
```

- [ ] **Step 4: Confirm pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/curve.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/curve.ts test/strategy/curve.test.ts
git commit -m "strategy: curve bell-shape with intent-based one-sided fallback"
```

---

## Task 4: Implement spot-concentrated + tests

**Files:**
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/spot-concentrated.ts`
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/strategy/spot-concentrated.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/strategy/spot-concentrated.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SpotConcentratedStrategy } from '../../src/strategy/spot-concentrated'

const ONE = 10n ** 18n
const ACTIVE = 8388608

describe('SpotConcentratedStrategy.plan', () => {
  it('two-sided: builds a 6-bin uniform shape with sums = 1e18 on each side', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    expect(plan.binIds).toHaveLength(6)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('two-sided: X bins are all above active, Y bins all below active', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    plan.binIds.forEach((id, i) => {
      if (plan.distributionX[i] > 0n) expect(id).toBeGreaterThan(ACTIVE)
      if (plan.distributionY[i] > 0n) expect(id).toBeLessThan(ACTIVE)
    })
  })

  it('Y-only fallback: when xAvailable too small, filters to below-active bins', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: 0n, yAvailable: ONE, binStep: 100,
    })
    expect(plan.binIds.every((id) => id < ACTIVE)).toBe(true)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('X-only fallback: when yAvailable too small, filters to above-active bins', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: 0n, binStep: 100,
    })
    expect(plan.binIds.every((id) => id > ACTIVE)).toBe(true)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(ONE)
  })

  it('no phantom bins: every bin has X or Y weight > 0', () => {
    const strat = new SpotConcentratedStrategy({ binCount: 6, binsAbove: 3, binsBelow: 3 })
    const plan = strat.plan({
      activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
    })
    plan.binIds.forEach((_, i) => {
      expect(plan.distributionX[i] > 0n || plan.distributionY[i] > 0n).toBe(true)
    })
  })

  it('rejects mismatched binCount / binsAbove + binsBelow', () => {
    expect(() => new SpotConcentratedStrategy({ binCount: 6, binsAbove: 4, binsBelow: 3 }))
      .toThrow(/binsAbove \+ binsBelow must equal binCount/)
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/spot-concentrated.test.ts
```

Expected: 6 fail — module-not-found.

- [ ] **Step 3: Implement spot-concentrated.ts**

Create `src/strategy/spot-concentrated.ts`:

```ts
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
      amountX: xAvailable,
      amountY: yAvailable,
    }
  }
}
```

- [ ] **Step 4: Confirm pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/spot-concentrated.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/spot-concentrated.ts test/strategy/spot-concentrated.test.ts
git commit -m "strategy: spot-concentrated tight uniform with narrow defaults"
```

---

## Task 5: Wire new strategies into factory

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/factory.ts`

- [ ] **Step 1: Update factory.ts**

Open `src/strategy/factory.ts` and replace its body:

```ts
import { SpotSpreadStrategy } from './spot-spread'
import { SpotWideStrategy } from './spot-wide'
import { WallStrategy } from './wall'
import { BidAskStrategy } from './bid-ask'
import { CurveStrategy } from './curve'
import { SpotConcentratedStrategy } from './spot-concentrated'

export function buildStrategy(spec: {
  type: 'spot-spread' | 'spot-wide' | 'wall' | 'spot-concentrated' | 'curve' | 'bid-ask'
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
    case 'spot-concentrated':
      return new SpotConcentratedStrategy({
        binCount: spec.knobs.binCount ?? 6,
        binsAbove: spec.knobs.binsAbove ?? 3,
        binsBelow: spec.knobs.binsBelow ?? 3,
      })
    case 'curve':
      return new CurveStrategy({
        binCount: spec.knobs.binCount ?? 20,
        binsAbove: spec.knobs.binsAbove ?? 10,
        binsBelow: spec.knobs.binsBelow ?? 10,
      })
    case 'bid-ask':
      return new BidAskStrategy({
        binCount: spec.knobs.binCount ?? 20,
        binsAbove: spec.knobs.binsAbove ?? 10,
        binsBelow: spec.knobs.binsBelow ?? 10,
      })
  }
}
```

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npm test
```

Expected: all existing tests still pass + 18 new strategy tests pass. Pre-existing failures (if any) unchanged.

- [ ] **Step 3: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/factory.ts
git commit -m "factory: dispatch bid-ask, curve, spot-concentrated"
```

---

## Task 6: Bump pitbot version + build + push image

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/package.json`

- [ ] **Step 1: Bump version**

In `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/package.json`, change:

```json
"version": "0.1.11",
```

to:

```json
"version": "0.1.12",
```

- [ ] **Step 2: Commit version bump**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add package.json
git commit -m "v0.1.12: package version bump for advanced strategies"
```

- [ ] **Step 3: Build image (linux/amd64 for SecretVM)**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
docker build --platform linux/amd64 -t ghcr.io/electrickc/janus-starter-bot:v0.1.12 . 2>&1 | tail -10
```

Expected: `naming to ghcr.io/electrickc/janus-starter-bot:v0.1.12 done`.

- [ ] **Step 4: Push**

```bash
docker push ghcr.io/electrickc/janus-starter-bot:v0.1.12 2>&1 | tail -5
```

Expected: a successful `v0.1.12: digest: sha256:... size: ...` line at the end.

- [ ] **Step 5: Verify image is public-pullable**

```bash
docker manifest inspect ghcr.io/electrickc/janus-starter-bot:v0.1.12 | head -5
```

Expected: a manifest JSON, not "no such manifest". If it fails with auth, the image is private; make it public via the GitHub packages UI before continuing.

---

## Task 7: Janus-app provision YAML bump + deploy

**Files:**
- Modify: `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts`

- [ ] **Step 1: Update the image tag in the inlined YAML**

In `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts`, find the line:

```
image: ghcr.io/electrickc/janus-starter-bot:v0.1.11
```

Change to:

```
image: ghcr.io/electrickc/janus-starter-bot:v0.1.12
```

- [ ] **Step 2: Commit on janus-app main**

```bash
cd /Users/electrickc/DUNGEONLABS/janus-app
git add src/app/api/v1/admin/pools/[id]/provision/route.ts
git commit -m "provision: bump janus-starter-bot to v0.1.12

v0.1.12 implements bid-ask, curve, and spot-concentrated strategies, so
ADVANCED-tier pools can pick them without leaving the bot stuck PAUSED."
```

- [ ] **Step 3: Deploy**

```bash
cd /Users/electrickc/DUNGEONLABS/janus-app && npm run deploy:prod 2>&1 | tail -5
```

Expected: deploy succeeds, custom domain alias re-points.

---

## Task 8: Apply v0.1.12 to the two live VMs

**Files:** none (`secretvm-cli` operations + a temp compose file).

- [ ] **Step 1: Write the v0.1.12 compose YAML**

Write the following to `/tmp/janus-bot-compose-v0.1.12.yml`:

```yaml
services:
  bot:
    image: ghcr.io/electrickc/janus-starter-bot:v0.1.12
    environment:
      POOL_ID: ${POOL_ID}
      CONTROL_PLANE_URL: ${CONTROL_PLANE_URL}
      CONTROL_PLANE_TOKEN: ${CONTROL_PLANE_TOKEN}
      RPC_URL: ${RPC_URL}
      STATE_PATH: /data/state.json
    volumes:
      - bot-state:/data
    restart: unless-stopped

volumes:
  bot-state:
```

- [ ] **Step 2: Push to Pool 1 (`maroon-mandrill`)**

```bash
secretvm-cli vm edit -d /tmp/janus-bot-compose-v0.1.12.yml cmqaod1dg00gmn0iqhcm2esrg 2>&1 | tail -3
```

Expected: `{"status":"success",...,"vm_status":"running","vm_name":"maroon-mandrill"}`. Preserves wallet.key + state.json (the encrypted FS is re-opened during the restart cycle).

- [ ] **Step 3: Push to Pool 2 (`salmon-guppy`)**

```bash
secretvm-cli vm edit -d /tmp/janus-bot-compose-v0.1.12.yml cmq9zxfny00f4n0iq8c323d4n 2>&1 | tail -3
```

Expected: `{"status":"success",...,"vm_name":"salmon-guppy"}`.

- [ ] **Step 4: Confirm new image is live on both VMs**

```bash
secretvm-cli vm status cmqaod1dg00gmn0iqhcm2esrg | grep -o 'janus-starter-bot:v0\.1\.[0-9]*'
secretvm-cli vm status cmq9zxfny00f4n0iq8c323d4n | grep -o 'janus-starter-bot:v0\.1\.[0-9]*'
```

Expected: both print `janus-starter-bot:v0.1.12`.

- [ ] **Step 5: Pull logs to confirm bot booted cleanly**

```bash
secretvm-cli vm logs cmqaod1dg00gmn0iqhcm2esrg 2>&1 | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
lines = d['result'].split('\n')
keep = [l for l in lines if 'docker_wd-bot' in l and ('[boot]' in l or '[reconcile]' in l or 'done in' in l or '[tick]' in l)]
for l in keep[-15:]:
    print(re.sub(r'^.+docker_wd-bot-1\[\d+\]:\s*', '', l).strip())
"
```

Expected sequence: `[boot] pool=... state=...` → `[reconcile] start` → `[reconcile] activeBin=...` → `[reconcile] done in <N>ms` → `[reconcile] → OPERATIONAL` → `[tick] active=... action=hold|place ...`.

If a pool is on `bid-ask`/`curve`/`spot-concentrated` after the upgrade, the reconcile log should reach `[reconcile] strategy=<that name> signer/tx layers ready` without crashing.

- [ ] **Step 6: Repeat the log check for Pool 2**

```bash
secretvm-cli vm logs cmq9zxfny00f4n0iq8c323d4n 2>&1 | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
lines = d['result'].split('\n')
keep = [l for l in lines if 'docker_wd-bot' in l and ('[boot]' in l or '[reconcile]' in l or 'done in' in l or '[tick]' in l)]
for l in keep[-15:]:
    print(re.sub(r'^.+docker_wd-bot-1\[\d+\]:\s*', '', l).strip())
"
```

Expected: clean reconcile cycle.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Implementing task |
|---|---|
| `Strategy.id` union widening | Task 1 |
| bid-ask U-shape implementation | Task 2 |
| bid-ask one-sided fallbacks | Task 2 (Y-only + X-only fallback tests) |
| curve bell-shape implementation | Task 3 |
| curve one-sided fallbacks | Task 3 (Y-only + X-only fallback tests) |
| spot-concentrated narrow uniform | Task 4 |
| spot-concentrated one-sided fallbacks | Task 4 (Y-only + X-only fallback tests) |
| factory.ts cases + union widening | Task 5 |
| Distribution sums = 1e18 invariant | Tasks 2, 3, 4 (each has sum tests) |
| No-phantom-bins invariant | Tasks 2, 3, 4 |
| `package.json` 0.1.11 → 0.1.12 | Task 6 step 1 |
| `docker build --platform linux/amd64` + push | Task 6 steps 3-5 |
| janus-app provision YAML bump | Task 7 |
| `vm edit` rollout to both VMs | Task 8 |
| Preserves wallet.key + state.json | Task 8 (uses vm edit, not re-provision) |

No gaps.

**Placeholder scan:** clean. Every code block is complete; every command has explicit expected output.

**Type consistency:**
- `Strategy['id']` literal value used in each new strategy's `readonly id = ...` matches the union widening from Task 1.
- The 6 strategy literal names in `factory.ts` (Task 5) match the union in `index.ts` (Task 1).
- `BidAskConfig`, `CurveConfig`, `SpotConcentratedConfig` interface fields (`binCount`, `binsAbove`, `binsBelow`) match the factory's default arguments.
- `PlanInput` (existing) is referenced consistently; tests pass `binStep` even though existing tests don't (precaution for the future, no runtime effect today).
- The compose YAML in Task 8 step 1 matches the v0.1.11 compose used previously, only the image tag differs.

All consistent.
