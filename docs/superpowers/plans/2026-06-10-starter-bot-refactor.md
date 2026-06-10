# STARTER Bot Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `dungeonclaw-pitbot` from single-tenant WETH/DCLAW PitBot into a per-pool multi-tenant STARTER bot that signs Safe transactions, talks to a control plane via outbound polling, and supports three strategies (Spot-Spread, Spot-Wide, Wall) behind a common interface.

**Architecture:** State-machine-driven TypeScript bot. Single Docker image, parameterized by env vars at container start (`POOL_ID`, `CONTROL_PLANE_URL`, `CONTROL_PLANE_TOKEN`, `RPC_URL`). Generates own EOA wallet on first boot (key stays in process memory, sealed by SecretVM TEE in production). Polls control plane for config + commands; executes via 1-of-2 Gnosis Safe. Pure-function strategies behind `Strategy` interface for easy unit testing.

**Tech Stack:** Node 20+, TypeScript 5.4, ethers v6, vitest for tests, anvil for fork-based integration tests, express for the in-test mock control plane, `@safe-global/protocol-kit` for Safe transaction building.

**Important context — branch strategy:** This is an in-place refactor on a feature branch (`feat/starter-bot`). The existing PitBot stays on `main` and continues to run DungeonClaw's production DCLAW/WETH pool. When the new bot is fully tested, ops migrates DCLAW to the new stack as the first STARTER customer and decommissions the old.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-10-starter-bot-refactor-design.md`.

---

## File structure

```
src/
├── index.ts                 # main loop, state machine driver
├── config.ts                # env var loader (single struct)
├── controlPlane.ts          # outbound HTTP client (handshake, sync, events)
├── pool.ts                  # provider, bot wallet, Safe/helper/pair wrappers
├── price.ts                 # active bin tracker (port from current)
├── safeSigner.ts            # Safe signing + execTransaction submission
├── tx.ts                    # high-level helper ops via Safe
├── state.ts                 # state machine + disk persistence
├── trigger.ts               # drift-based re-center decide()
├── abi.ts                   # extended with Safe ABI
└── strategy/
    ├── index.ts             # Strategy interface + MintPlan type
    ├── spot-spread.ts       # ~20 bin uniform-around-active
    ├── spot-wide.ts         # ~50 bin uniform-around-active
    └── wall.ts              # one-sided defensive wall (ported)

test/
├── strategy/
│   ├── spot-spread.test.ts
│   ├── spot-wide.test.ts
│   └── wall.test.ts
├── trigger.test.ts
├── state.test.ts
├── controlPlane.test.ts
├── safeSigner.test.ts
└── integration/
    ├── helpers.ts           # anvil + mock CP boot helpers
    └── full-lifecycle.test.ts
```

**Deleted (replaced):**
- `src/webhook.ts` — replaced by `controlPlane.ts` events
- `src/index.ts` (current 388 LoC) — rewritten

---

## Phase 0 — Test infrastructure

### Task 1: Add vitest + Safe SDK + dev deps

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install deps**

Run from repo root:
```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
npm install --save-dev vitest @vitest/coverage-v8 express @types/express msw
npm install @safe-global/protocol-kit @safe-global/types-kit
```

- [ ] **Step 2: Add test scripts**

Edit `package.json` `scripts` block to add:
```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "dev": "ts-node src/index.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:integration": "vitest run test/integration"
}
```

- [ ] **Step 3: Verify**

Run: `npx vitest --version`
Expected: prints vitest version, e.g. `2.1.x`.

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/starter-bot
git add package.json package-lock.json
git commit -m "deps: add vitest + Safe SDK + express for STARTER bot refactor"
```

---

### Task 2: Vitest config

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Write the config**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // main loop is integration-tested only
    },
  },
})
```

- [ ] **Step 2: Sanity test that vitest runs**

```bash
echo 'test("sanity", () => { expect(1+1).toBe(2) })' > test/sanity.test.ts
mkdir -p test
npx vitest run test/sanity.test.ts
```
Expected: 1 test passed.

- [ ] **Step 3: Clean up**

```bash
rm test/sanity.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts
git commit -m "test: vitest config (unit tests separated from integration)"
```

---

## Phase 1 — Strategy interface + Spot-Spread

### Task 3: Strategy interface + MintPlan type

**Files:**
- Create: `src/strategy/index.ts`

- [ ] **Step 1: Write the interface**

```typescript
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
```

- [ ] **Step 2: Verify it typechecks**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/strategy/index.ts
git commit -m "strategy: define Strategy interface and MintPlan"
```

---

### Task 4: Spot-Spread strategy — two-sided test first

**Files:**
- Create: `test/strategy/spot-spread.test.ts`
- Create: `src/strategy/spot-spread.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { SpotSpreadStrategy } from '../../src/strategy/spot-spread'

describe('SpotSpreadStrategy.plan', () => {
  it('builds a 20-bin uniform shape centered on active when both assets present', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n, // 1 X
      yAvailable: 1_000_000_000_000_000_000n, // 1 Y
    })

    expect(plan.binIds).toHaveLength(20)
    // 10 bins below active should be distinct from 10 above
    const below = plan.binIds.filter((b) => b < 8388608)
    const above = plan.binIds.filter((b) => b > 8388608)
    expect(below).toHaveLength(10)
    expect(above).toHaveLength(10)

    // distributionX should be nonzero only on or above active bin
    const sumX = plan.distributionX.reduce((a, b) => a + b, 0n)
    const sumY = plan.distributionY.reduce((a, b) => a + b, 0n)
    expect(sumX).toBe(10n ** 18n)
    expect(sumY).toBe(10n ** 18n)

    expect(plan.amountX).toBe(1_000_000_000_000_000_000n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
  })
})
```

- [ ] **Step 2: Run test (expected to fail because file doesn't exist)**

Run: `npx vitest run test/strategy/spot-spread.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement Spot-Spread two-sided**

```typescript
import type { Strategy, PlanInput, MintPlan } from './index'

export interface SpotSpreadConfig {
  binCount: number    // total bins; default 20
  binsAbove: number   // bins above active
  binsBelow: number   // bins below active
}

const ONE = 10n ** 18n

export class SpotSpreadStrategy implements Strategy {
  readonly id = 'spot-spread' as const

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

    // Build bin id list: descending from (active+binsAbove) to (active-binsBelow+1)
    const binIds: number[] = []
    for (let i = binsAbove; i >= -binsBelow + 1; i--) binIds.push(activeBin + i)

    // Build distributions. X populated on or above active. Y below or on active.
    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = new Array(binCount).fill(0n)

    if (oneSidedY) {
      // Y-only: distribute Y uniformly across binsBelow bins below active
      const yBins = binsBelow
      const per = ONE / BigInt(yBins)
      let assigned = 0n
      for (let i = 0; i < binCount; i++) {
        if (binIds[i] < activeBin) {
          distributionY[i] = per
          assigned += per
        }
      }
      // Top up last Y bin to make sum exactly ONE
      for (let i = binCount - 1; i >= 0; i--) {
        if (distributionY[i] > 0n) {
          distributionY[i] += ONE - assigned
          break
        }
      }
      return {
        binIds,
        distributionX,
        distributionY,
        amountX: 0n,
        amountY: yAvailable,
      }
    }

    if (oneSidedX) {
      // X-only: distribute X uniformly across binsAbove bins above active
      const xBins = binsAbove
      const per = ONE / BigInt(xBins)
      let assigned = 0n
      for (let i = 0; i < binCount; i++) {
        if (binIds[i] > activeBin) {
          distributionX[i] = per
          assigned += per
        }
      }
      for (let i = 0; i < binCount; i++) {
        if (distributionX[i] > 0n) {
          distributionX[i] += ONE - assigned
          break
        }
      }
      return {
        binIds,
        distributionX,
        distributionY,
        amountX: xAvailable,
        amountY: 0n,
      }
    }

    // Two-sided. Y goes below active, X above. Active bin itself splits 50/50.
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
      } else {
        // active bin — half X, half Y
        const hx = xPer / 2n
        const hy = yPer / 2n
        distributionX[i] = hx
        distributionY[i] = hy
        sumX += hx
        sumY += hy
      }
    }
    // Reconcile rounding into first bin
    for (let i = 0; i < binCount; i++) {
      if (distributionX[i] > 0n) {
        distributionX[i] += ONE - sumX
        break
      }
    }
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
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/strategy/spot-spread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/spot-spread.ts test/strategy/spot-spread.test.ts
git commit -m "strategy: SpotSpread two-sided implementation + test"
```

---

### Task 5: Spot-Spread — Y-only fallback test

**Files:**
- Modify: `test/strategy/spot-spread.test.ts`

- [ ] **Step 1: Add the test**

Append to the describe block:
```typescript
  it('one-sided Y when xAvailable is dust', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1n, // dust
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(0n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    // All Y must be at bins below active
    for (let i = 0; i < plan.binIds.length; i++) {
      if (plan.distributionY[i] > 0n) {
        expect(plan.binIds[i]).toBeLessThan(8388608)
      }
    }
  })
```

- [ ] **Step 2: Run test**

Run: `npx vitest run test/strategy/spot-spread.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/strategy/spot-spread.test.ts
git commit -m "strategy: test SpotSpread Y-only fallback"
```

---

### Task 6: Spot-Spread — X-only fallback test

**Files:**
- Modify: `test/strategy/spot-spread.test.ts`

- [ ] **Step 1: Add the test**

```typescript
  it('one-sided X when yAvailable is dust', () => {
    const strat = new SpotSpreadStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1n,
    })
    expect(plan.amountX).toBe(1_000_000_000_000_000_000n)
    expect(plan.amountY).toBe(0n)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(0n)
    for (let i = 0; i < plan.binIds.length; i++) {
      if (plan.distributionX[i] > 0n) {
        expect(plan.binIds[i]).toBeGreaterThan(8388608)
      }
    }
  })
```

- [ ] **Step 2: Run test**

Run: `npx vitest run test/strategy/spot-spread.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/strategy/spot-spread.test.ts
git commit -m "strategy: test SpotSpread X-only fallback"
```

---

## Phase 2 — Spot-Wide

### Task 7: Spot-Wide — extends Spot-Spread with wider default binCount

**Files:**
- Create: `test/strategy/spot-wide.test.ts`
- Create: `src/strategy/spot-wide.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest'
import { SpotWideStrategy } from '../../src/strategy/spot-wide'

describe('SpotWideStrategy', () => {
  it('defaults to ~50 bins', () => {
    const strat = new SpotWideStrategy({ binCount: 50, binsAbove: 25, binsBelow: 25 })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 1_000_000_000_000_000_000n,
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.binIds).toHaveLength(50)
    expect(plan.distributionX.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
  })

  it('reports its strategy id', () => {
    const strat = new SpotWideStrategy({ binCount: 50, binsAbove: 25, binsBelow: 25 })
    expect(strat.id).toBe('spot-wide')
  })
})
```

- [ ] **Step 2: Run test (expected to fail)**

Run: `npx vitest run test/strategy/spot-wide.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Spot-Wide as a Spot-Spread subclass**

```typescript
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
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/strategy/spot-wide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/spot-wide.ts test/strategy/spot-wide.test.ts
git commit -m "strategy: SpotWide as subclass of SpotSpread with wider default"
```

---

## Phase 3 — Wall

### Task 8: Port WallStrategy from current src/strategy.ts

**Files:**
- Create: `test/strategy/wall.test.ts`
- Create: `src/strategy/wall.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest'
import { WallStrategy } from '../../src/strategy/wall'

describe('WallStrategy.plan', () => {
  it('builds an exponential-skew Y-only wall below active', () => {
    const strat = new WallStrategy({
      binCount: 7,
      offsetFromActive: 1,
      skew: 'exponential',
    })
    const plan = strat.plan({
      activeBin: 8388608,
      xAvailable: 0n,
      yAvailable: 1_000_000_000_000_000_000n,
    })
    expect(plan.binIds).toHaveLength(7)
    // First bin id = active - 1, last = active - 7
    expect(plan.binIds[0]).toBe(8388607)
    expect(plan.binIds[6]).toBe(8388601)
    // No X, all Y
    expect(plan.amountX).toBe(0n)
    expect(plan.amountY).toBe(1_000_000_000_000_000_000n)
    // distributionY sums to 1e18
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
    // Exponential skew: deepest bin has the largest distribution
    expect(plan.distributionY[6]).toBeGreaterThan(plan.distributionY[0])
  })

  it('builds a linear-skew wall', () => {
    const strat = new WallStrategy({
      binCount: 5,
      offsetFromActive: 2,
      skew: 'linear',
    })
    const plan = strat.plan({
      activeBin: 100,
      xAvailable: 0n,
      yAvailable: 5_000_000_000_000_000_000n,
    })
    expect(plan.binIds).toEqual([98, 97, 96, 95, 94])
    // Linear weights 1,2,3,4,5; total=15
    // Each share = totalY * weight / 15, distribution sums to 1e18
    expect(plan.distributionY.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n)
  })

  it('rejects when only X is available (wall is Y-only)', () => {
    const strat = new WallStrategy({
      binCount: 7,
      offsetFromActive: 1,
      skew: 'exponential',
    })
    expect(() =>
      strat.plan({
        activeBin: 100,
        xAvailable: 1_000_000_000_000_000_000n,
        yAvailable: 0n,
      }),
    ).toThrow(/no Y available/)
  })
})
```

- [ ] **Step 2: Run test (expected to fail)**

Run: `npx vitest run test/strategy/wall.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement WallStrategy**

```typescript
import type { Strategy, PlanInput, MintPlan } from './index'

export interface WallConfig {
  binCount: number          // wall bins (default 7)
  offsetFromActive: number  // gap between active and shallowest wall bin (default 1)
  skew: 'linear' | 'exponential'
}

const ONE = 10n ** 18n

export class WallStrategy implements Strategy {
  readonly id = 'wall' as const

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

    // Bin IDs: active - offset, active - offset - 1, ... active - offset - count + 1
    const binIds: number[] = []
    for (let i = 0; i < binCount; i++) binIds.push(activeBin - offsetFromActive - i)

    // Weights: deepest bin (last in array) gets the largest share.
    // exponential: 1, 2, 4, 8, ... 2^(count-1)
    // linear: 1, 2, 3, ... count
    const weights: bigint[] = []
    for (let i = 0; i < binCount; i++) {
      weights.push(skew === 'exponential' ? 1n << BigInt(i) : BigInt(i + 1))
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0n)

    // Y distribution. distributionX is all zeros.
    const distributionX: bigint[] = new Array(binCount).fill(0n)
    const distributionY: bigint[] = []
    let sumY = 0n
    for (let i = 0; i < binCount - 1; i++) {
      const d = (weights[i] * ONE) / totalWeight
      distributionY.push(d)
      sumY += d
    }
    distributionY.push(ONE - sumY) // last bin absorbs rounding

    return {
      binIds,
      distributionX,
      distributionY,
      amountX: 0n,
      amountY: yAvailable,
    }
  }
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/strategy/wall.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/wall.ts test/strategy/wall.test.ts
git commit -m "strategy: Wall (ported from current PitBot logic)"
```

---

## Phase 4 — Trigger

### Task 9: Trigger module

**Files:**
- Create: `test/trigger.test.ts`
- Create: `src/trigger.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest'
import { decide } from '../src/trigger'

describe('trigger.decide', () => {
  it('returns place when no current position', () => {
    const r = decide({
      activeBin: 100,
      currentCenter: null,
      lastRebalanceTs: 0,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('place')
  })

  it('returns hold when within tolerance', () => {
    const r = decide({
      activeBin: 102,
      currentCenter: 100,
      lastRebalanceTs: 0,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 5,
    })
    expect(r.action).toBe('hold')
  })

  it('returns reposition when drift exceeds threshold and cooldown elapsed', () => {
    const r = decide({
      activeBin: 110,
      currentCenter: 100,
      lastRebalanceTs: 1,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('reposition')
  })

  it('returns hold when drift exceeds threshold but cooldown active', () => {
    const r = decide({
      activeBin: 110,
      currentCenter: 100,
      lastRebalanceTs: 990,
      nowTs: 1000,
      anyBinFilled: false,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('hold')
  })

  it('returns withdraw_filled when any bin filled and cooldown elapsed', () => {
    const r = decide({
      activeBin: 100,
      currentCenter: 100,
      lastRebalanceTs: 1,
      nowTs: 1000,
      anyBinFilled: true,
      rebalanceCooldownSeconds: 60,
      rebalanceBinsThreshold: 2,
    })
    expect(r.action).toBe('withdraw_filled')
  })
})
```

- [ ] **Step 2: Run test (expected to fail)**

Run: `npx vitest run test/trigger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
export interface DecideInput {
  activeBin: number
  /** Center of current LP position, or null if nothing placed. */
  currentCenter: number | null
  /** Unix ts (seconds) of last successful rebalance. 0 = never. */
  lastRebalanceTs: number
  /** Unix ts (seconds) — usually Math.floor(Date.now() / 1000). */
  nowTs: number
  /** True if any of our bins crossed below active (became X / DCLAW). */
  anyBinFilled: boolean
  rebalanceCooldownSeconds: number
  /** Bins of drift from currentCenter before reposition fires. */
  rebalanceBinsThreshold: number
}

export interface DecideOutput {
  action: 'hold' | 'place' | 'reposition' | 'withdraw_filled'
  reason: string
}

export function decide(opts: DecideInput): DecideOutput {
  const cooldownExpired = opts.nowTs - opts.lastRebalanceTs >= opts.rebalanceCooldownSeconds

  if (opts.currentCenter === null) {
    return { action: 'place', reason: 'no position present' }
  }

  if (opts.anyBinFilled) {
    if (!cooldownExpired) return { action: 'hold', reason: 'fill detected but cooldown active' }
    return { action: 'withdraw_filled', reason: 'bin(s) filled — withdraw and reset' }
  }

  const drift = Math.abs(opts.activeBin - opts.currentCenter)
  if (drift > opts.rebalanceBinsThreshold) {
    if (!cooldownExpired) return { action: 'hold', reason: 'drift exceeds threshold but cooldown active' }
    return { action: 'reposition', reason: `drift ${drift} > threshold ${opts.rebalanceBinsThreshold}` }
  }

  return { action: 'hold', reason: 'within tolerance' }
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/trigger.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/trigger.ts test/trigger.test.ts
git commit -m "trigger: drift-based decide() module + tests"
```

---

## Phase 5 — Control plane client

### Task 10: ControlPlane HTTP client — handshake test

**Files:**
- Create: `test/controlPlane.test.ts`
- Create: `src/controlPlane.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { ControlPlaneClient } from '../src/controlPlane'

describe('ControlPlaneClient', () => {
  let server: Server
  let received: { handshake?: any } = {}

  beforeEach(async () => {
    received = {}
    const app = express()
    app.use(express.json())
    app.post('/pools/:poolId/handshake', (req, res) => {
      received.handshake = { poolId: req.params.poolId, body: req.body }
      res.status(200).json({ ok: true })
    })
    server = app.listen(0)
  })

  afterEach(() => {
    server.close()
  })

  it('sends handshake with bot address', async () => {
    const port = (server.address() as any).port
    const client = new ControlPlaneClient({
      baseUrl: `http://localhost:${port}`,
      token: 'test-token',
      poolId: 'pool-xyz',
    })
    await client.handshake('0xABCDEF0000000000000000000000000000000001')
    expect(received.handshake?.poolId).toBe('pool-xyz')
    expect(received.handshake?.body.botAddress).toBe('0xABCDEF0000000000000000000000000000000001')
  })
})
```

- [ ] **Step 2: Run test (expected to fail)**

Run: `npx vitest run test/controlPlane.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement minimally**

```typescript
export interface ControlPlaneConfig {
  baseUrl: string
  token: string
  poolId: string
}

export interface SyncResponse {
  status: 'pending_safe_setup' | 'operational' | 'paused' | 'retired'
  safeAddress: string | null
  helperAddress: string | null
  pairAddress: string | null
  strategy: {
    type: 'spot-spread' | 'spot-wide' | 'wall'
    knobs: Record<string, any>
  } | null
  rebalanceCooldownSeconds: number
  syncPollIntervalSeconds: number
  chainPollIntervalSeconds: number
  killSwitch: boolean
  consecutiveSyncFailureThreshold: number
}

export interface Event {
  ts: number
  type: 'rebalance' | 'place' | 'withdraw' | 'error' | 'state_transition'
  payload: Record<string, any>
}

export class ControlPlaneClient {
  constructor(private readonly cfg: ControlPlaneConfig) {}

  async handshake(botAddress: string, version = '1.0.0'): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}/pools/${this.cfg.poolId}/handshake`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-control-token': this.cfg.token,
      },
      body: JSON.stringify({ botAddress, version }),
    })
    if (!res.ok) throw new Error(`handshake failed: ${res.status}`)
  }

  async sync(): Promise<SyncResponse> {
    const res = await fetch(`${this.cfg.baseUrl}/pools/${this.cfg.poolId}/sync`, {
      headers: { 'x-control-token': this.cfg.token },
    })
    if (!res.ok) throw new Error(`sync failed: ${res.status}`)
    return res.json() as Promise<SyncResponse>
  }

  async emitEvent(event: Event): Promise<void> {
    // Fire-and-forget but await the request for simplicity
    const res = await fetch(`${this.cfg.baseUrl}/pools/${this.cfg.poolId}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-control-token': this.cfg.token,
      },
      body: JSON.stringify(event),
    })
    if (!res.ok) throw new Error(`event emit failed: ${res.status}`)
  }
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/controlPlane.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controlPlane.ts test/controlPlane.test.ts
git commit -m "controlPlane: HTTP client with handshake + sync + events"
```

---

### Task 11: ControlPlane sync + event tests

**Files:**
- Modify: `test/controlPlane.test.ts`

- [ ] **Step 1: Add tests**

Inside the describe block, after the existing test:
```typescript
  it('reads sync response', async () => {
    const port = (server.address() as any).port
    const app = (server as any)._events.request as express.Express
    app.get('/pools/:poolId/sync', (_req, res) => {
      res.json({
        status: 'pending_safe_setup',
        safeAddress: null,
        helperAddress: null,
        pairAddress: null,
        strategy: null,
        rebalanceCooldownSeconds: 60,
        syncPollIntervalSeconds: 30,
        chainPollIntervalSeconds: 15,
        killSwitch: false,
        consecutiveSyncFailureThreshold: 5,
      })
    })
    const client = new ControlPlaneClient({
      baseUrl: `http://localhost:${port}`,
      token: 'test',
      poolId: 'pool-xyz',
    })
    const sync = await client.sync()
    expect(sync.status).toBe('pending_safe_setup')
    expect(sync.safeAddress).toBeNull()
  })

  it('throws on 5xx sync error', async () => {
    const port = (server.address() as any).port
    const app = (server as any)._events.request as express.Express
    app.get('/pools/:poolId/sync', (_req, res) => res.status(500).send('boom'))
    const client = new ControlPlaneClient({
      baseUrl: `http://localhost:${port}`,
      token: 'test',
      poolId: 'pool-xyz',
    })
    await expect(client.sync()).rejects.toThrow(/sync failed: 500/)
  })
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/controlPlane.test.ts`
Expected: PASS (all 3).

- [ ] **Step 3: Commit**

```bash
git add test/controlPlane.test.ts
git commit -m "controlPlane: test sync success + 5xx error path"
```

---

## Phase 6 — State machine

### Task 12: State module with disk persistence

**Files:**
- Create: `test/state.test.ts`
- Create: `src/state.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BotStateManager, BotState } from '../src/state'

describe('BotStateManager', () => {
  let tmpDir: string
  let statePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'))
    statePath = path.join(tmpDir, 'state.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initializes in BOOT state', () => {
    const mgr = new BotStateManager(statePath)
    expect(mgr.current).toBe('BOOT')
  })

  it('persists state transitions to disk', () => {
    const mgr = new BotStateManager(statePath)
    mgr.transition('PENDING_SAFE_SETUP', { reason: 'no safe yet' })
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8')) as BotState
    expect(onDisk.current).toBe('PENDING_SAFE_SETUP')
  })

  it('restores from disk on reboot', () => {
    const mgr1 = new BotStateManager(statePath)
    mgr1.transition('OPERATIONAL', { lastRebalanceTs: 12345, currentCenter: 8388608 })
    const mgr2 = new BotStateManager(statePath)
    expect(mgr2.current).toBe('OPERATIONAL')
    expect(mgr2.snapshot.lastRebalanceTs).toBe(12345)
    expect(mgr2.snapshot.currentCenter).toBe(8388608)
  })

  it('rejects invalid transitions', () => {
    const mgr = new BotStateManager(statePath)
    expect(() => mgr.transition('OPERATIONAL', {})).toThrow(/invalid transition/)
  })
})
```

- [ ] **Step 2: Run test (expected to fail)**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import fs from 'fs'
import path from 'path'

export type StateName =
  | 'BOOT'
  | 'PENDING_SAFE_SETUP'
  | 'RECONCILE'
  | 'OPERATIONAL'
  | 'PAUSED'
  | 'RETIRED'

export interface BotState {
  current: StateName
  lastTransitionTs: number
  reason: string
  lastRebalanceTs: number
  currentCenter: number | null
}

const VALID_TRANSITIONS: Record<StateName, StateName[]> = {
  BOOT: ['PENDING_SAFE_SETUP'],
  PENDING_SAFE_SETUP: ['RECONCILE', 'PAUSED', 'RETIRED'],
  RECONCILE: ['OPERATIONAL', 'PAUSED', 'RETIRED'],
  OPERATIONAL: ['PAUSED', 'RETIRED'],
  PAUSED: ['OPERATIONAL', 'RETIRED'],
  RETIRED: [],
}

export class BotStateManager {
  private state: BotState

  constructor(private readonly statePath: string) {
    if (fs.existsSync(statePath)) {
      this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } else {
      this.state = {
        current: 'BOOT',
        lastTransitionTs: 0,
        reason: 'initial',
        lastRebalanceTs: 0,
        currentCenter: null,
      }
      this.persist()
    }
  }

  get current(): StateName {
    return this.state.current
  }

  get snapshot(): Readonly<BotState> {
    return { ...this.state }
  }

  transition(to: StateName, fields: Partial<BotState> & { reason?: string }): void {
    const allowed = VALID_TRANSITIONS[this.state.current]
    if (!allowed.includes(to)) {
      throw new Error(`invalid transition: ${this.state.current} -> ${to}`)
    }
    this.state = {
      ...this.state,
      ...fields,
      current: to,
      lastTransitionTs: Math.floor(Date.now() / 1000),
      reason: fields.reason ?? this.state.reason,
    }
    this.persist()
  }

  /** Mutate state without changing the state name. Use for updating lastRebalanceTs etc. */
  update(fields: Partial<Omit<BotState, 'current'>>): void {
    this.state = { ...this.state, ...fields }
    this.persist()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2))
  }
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "state: BotStateManager with disk persistence + transition validation"
```

---

## Phase 7 — Config

### Task 13: Config loader

**Files:**
- Modify: `src/config.ts` (rewrite the entire file)

- [ ] **Step 1: Replace config.ts**

```typescript
import * as fs from 'fs'

function loadSecret(name: string, required: boolean): string | undefined {
  const filePath = process.env[`${name}_FILE`]
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim()
  }
  const direct = process.env[name]
  if (direct) return direct.trim()
  if (required) throw new Error(`Missing secret: ${name} (set ${name} or ${name}_FILE)`)
  return undefined
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

export interface BotConfig {
  poolId: string
  controlPlaneUrl: string
  controlPlaneToken: string
  rpcUrl: string
  statePath: string
}

export function loadConfig(): BotConfig {
  return {
    poolId: req('POOL_ID'),
    controlPlaneUrl: req('CONTROL_PLANE_URL'),
    controlPlaneToken: loadSecret('CONTROL_PLANE_TOKEN', true)!,
    rpcUrl: req('RPC_URL'),
    statePath: process.env.STATE_PATH ?? '/data/state.json',
  }
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "config: rewrite as minimal env-var loader for multi-tenant"
```

---

## Phase 8 — Pool wrappers

### Task 14: ABI definitions for Safe + helper + pair

**Files:**
- Modify: `src/abi.ts` (extend with Safe ABI)

- [ ] **Step 1: Extend abi.ts**

Replace the contents of `src/abi.ts` with:
```typescript
// LB Pair v2.0 (matches deployed TJ pair on Base)
export const LB_PAIR_ABI = [
  'function mint(uint256[] ids, uint256[] distributionX, uint256[] distributionY, address to) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burn(uint256[] ids, uint256[] amounts, address to) returns (uint256 amountX, uint256 amountY)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function totalSupply(uint256 id) view returns (uint256)',
  'function getReservesAndId() view returns (uint256, uint256, uint256)',
  'function tokenX() view returns (address)',
  'function tokenY() view returns (address)',
  'function feeParameters() view returns (uint16, uint16, uint16, uint16, uint16, uint24, uint16, uint24, uint24, uint24, uint24, uint40)',
] as const

// PitBotHelper (atomic mint+burn wrapper)
export const HELPER_ABI = [
  'function mintAtomic(uint256[] ids, uint256[] distributionX, uint256[] distributionY, uint256 amountX, uint256 amountY) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burnAtomic(uint256[] ids, uint256[] shares) returns (uint256 amountX, uint256 amountY)',
  'function sweep(address token)',
  'function OWNER() view returns (address)',
  'function PAIR() view returns (address)',
  'function WETH() view returns (address)',
  'function DCLAW() view returns (address)',
] as const

// Gnosis Safe v1.3+ (subset)
export const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function isOwner(address) view returns (bool)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
] as const

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
] as const
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/abi.ts
git commit -m "abi: extend with SAFE_ABI; reuse LB_PAIR_ABI, HELPER_ABI, ERC20_ABI"
```

---

### Task 15: Pool wrapper module

**Files:**
- Modify: `src/pool.ts` (rewrite)

- [ ] **Step 1: Replace pool.ts**

```typescript
import { ethers } from 'ethers'
import { LB_PAIR_ABI, HELPER_ABI, SAFE_ABI, ERC20_ABI } from './abi'

export interface PoolAddresses {
  pair: string
  helper: string
  safe: string
  tokenX: string
  tokenY: string
}

export interface PoolSnapshot {
  activeBin: number
  binStep: number
  safeXBalance: bigint
  safeYBalance: bigint
}

export interface BinPosition {
  id: number
  shares: bigint
  reserveX: bigint
  reserveY: bigint
}

export class Pool {
  readonly provider: ethers.JsonRpcProvider
  readonly wallet: ethers.Wallet
  readonly pair: ethers.Contract
  readonly helper: ethers.Contract
  readonly safe: ethers.Contract
  readonly tokenX: ethers.Contract
  readonly tokenY: ethers.Contract
  private cachedBinStep: number | null = null

  constructor(rpcUrl: string, botPrivateKey: string, readonly addrs: PoolAddresses) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true })
    this.wallet = new ethers.Wallet(botPrivateKey, this.provider)
    this.pair = new ethers.Contract(addrs.pair, LB_PAIR_ABI, this.wallet)
    this.helper = new ethers.Contract(addrs.helper, HELPER_ABI, this.wallet)
    this.safe = new ethers.Contract(addrs.safe, SAFE_ABI, this.wallet)
    this.tokenX = new ethers.Contract(addrs.tokenX, ERC20_ABI, this.wallet)
    this.tokenY = new ethers.Contract(addrs.tokenY, ERC20_ABI, this.wallet)
  }

  async getActiveBin(): Promise<number> {
    const [, , activeId] = await this.pair.getReservesAndId()
    return Number(activeId)
  }

  async getBinStep(): Promise<number> {
    if (this.cachedBinStep != null) return this.cachedBinStep
    const [bs] = await this.pair.feeParameters()
    this.cachedBinStep = Number(bs)
    return this.cachedBinStep
  }

  async snapshot(): Promise<PoolSnapshot> {
    const [activeBin, binStep, safeX, safeY] = await Promise.all([
      this.getActiveBin(),
      this.getBinStep(),
      this.tokenX.balanceOf(this.addrs.safe).then(BigInt),
      this.tokenY.balanceOf(this.addrs.safe).then(BigInt),
    ])
    return { activeBin, binStep, safeXBalance: safeX, safeYBalance: safeY }
  }

  /** Scan a window of bins around activeBin and return positions where Safe holds shares. */
  async safeBinPositions(activeBin: number, windowSize: number): Promise<BinPosition[]> {
    const start = activeBin - windowSize
    const end = activeBin + windowSize
    const positions: BinPosition[] = []
    for (let id = start; id <= end; id++) {
      const shares = BigInt(await this.pair.balanceOf(this.addrs.safe, id))
      if (shares > 0n) {
        positions.push({ id, shares, reserveX: 0n, reserveY: 0n })
      }
    }
    return positions
  }

  /** Assert invariants used at RECONCILE state. */
  async validateInvariants(): Promise<void> {
    const helperOwner = await this.helper.OWNER()
    if (helperOwner.toLowerCase() !== this.addrs.safe.toLowerCase()) {
      throw new Error(`helper owner is ${helperOwner}, expected Safe ${this.addrs.safe}`)
    }
    const isBotOwner = await this.safe.isOwner(this.wallet.address)
    if (!isBotOwner) {
      throw new Error(`bot wallet ${this.wallet.address} is not a Safe owner`)
    }
  }
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pool.ts
git commit -m "pool: rewrite as multi-tenant wrapper (provider, bot wallet, Safe/helper/pair/tokens)"
```

---

## Phase 9 — Safe signing

### Task 16: SafeSigner module

**Files:**
- Create: `test/safeSigner.test.ts`
- Create: `src/safeSigner.ts`

- [ ] **Step 1: Write a unit test for the signing math**

```typescript
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { computeSafeSignature } from '../src/safeSigner'

describe('computeSafeSignature', () => {
  it('produces a 65-byte signature in Safe pre-validated format', async () => {
    const wallet = ethers.Wallet.createRandom()
    const safeTxHash = ethers.keccak256(ethers.toUtf8Bytes('test'))
    const sig = await computeSafeSignature(wallet, safeTxHash)
    // 65 bytes hex = 132 chars + '0x' prefix
    expect(sig.length).toBe(132)
    // The last byte should be 0x1f, 0x20 or one of the EIP-191 v values
    const v = parseInt(sig.slice(-2), 16)
    expect([27, 28, 31, 32]).toContain(v)
  })
})
```

- [ ] **Step 2: Run test (expected to fail)**

Run: `npx vitest run test/safeSigner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { ethers } from 'ethers'

/**
 * Signs a Safe transaction hash producing a 65-byte signature in the format
 * Safe.execTransaction expects.
 *
 * Safe signature format: r (32) ++ s (32) ++ v (1).
 * EIP-191 prefix bumps v by +4 — Safe accepts both.
 */
export async function computeSafeSignature(
  wallet: ethers.Wallet,
  safeTxHash: string,
): Promise<string> {
  // ethers `signMessage` hashes with the EIP-191 prefix; safeTxHash is already a 32-byte
  // hash so we sign the digest directly using signingKey.
  const signing = (wallet as any).signingKey ?? new ethers.SigningKey(wallet.privateKey)
  const sig = signing.sign(safeTxHash)
  // Adjust v to 31/32 (Safe's pre-validated marker) so the bot's pre-signed sig is accepted.
  const adjustedV = sig.v + 4
  const r = sig.r.slice(2)
  const s = sig.s.slice(2)
  return `0x${r}${s}${adjustedV.toString(16).padStart(2, '0')}`
}

export interface SafeTxParams {
  to: string
  value: bigint
  data: string
  operation: number // 0 = CALL
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: string
  refundReceiver: string
}

export class SafeSigner {
  constructor(
    private readonly safe: ethers.Contract,
    private readonly wallet: ethers.Wallet,
  ) {}

  /** Build a Safe tx, sign with bot key, submit via execTransaction. */
  async execTransaction(params: SafeTxParams): Promise<ethers.TransactionReceipt> {
    const nonce = await this.safe.nonce()
    const safeTxHash: string = await this.safe.getTransactionHash(
      params.to,
      params.value,
      params.data,
      params.operation,
      params.safeTxGas,
      params.baseGas,
      params.gasPrice,
      params.gasToken,
      params.refundReceiver,
      nonce,
    )
    const sig = await computeSafeSignature(this.wallet, safeTxHash)
    const tx = await this.safe.execTransaction(
      params.to,
      params.value,
      params.data,
      params.operation,
      params.safeTxGas,
      params.baseGas,
      params.gasPrice,
      params.gasToken,
      params.refundReceiver,
      sig,
    )
    const receipt = await tx.wait()
    if (!receipt) throw new Error('no receipt')
    return receipt
  }
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/safeSigner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/safeSigner.ts test/safeSigner.test.ts
git commit -m "safeSigner: pre-validated Safe signature + execTransaction wrapper"
```

---

## Phase 10 — High-level tx ops

### Task 17: Tx module — mint via helper through Safe

**Files:**
- Create: `src/tx.ts`

- [ ] **Step 1: Write tx.ts**

```typescript
import { ethers } from 'ethers'
import { HELPER_ABI } from './abi'
import { Pool } from './pool'
import { SafeSigner } from './safeSigner'
import type { MintPlan } from './strategy'

const helperIface = new ethers.Interface(HELPER_ABI)

export class TxLayer {
  constructor(
    private readonly pool: Pool,
    private readonly signer: SafeSigner,
  ) {}

  /** Send Safe tx that calls helper.mintAtomic atomically. */
  async mint(plan: MintPlan): Promise<ethers.TransactionReceipt> {
    const data = helperIface.encodeFunctionData('mintAtomic', [
      plan.binIds,
      plan.distributionX,
      plan.distributionY,
      plan.amountX,
      plan.amountY,
    ])
    return this.signer.execTransaction({
      to: this.pool.addrs.helper,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    })
  }

  async burn(binIds: number[], shares: bigint[]): Promise<ethers.TransactionReceipt> {
    const data = helperIface.encodeFunctionData('burnAtomic', [binIds, shares])
    return this.signer.execTransaction({
      to: this.pool.addrs.helper,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    })
  }
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```
Expected: no errors. (No unit tests for `TxLayer` since it's just a thin wrapper — fork integration test covers it.)

- [ ] **Step 3: Commit**

```bash
git add src/tx.ts
git commit -m "tx: mint/burn ops calling helper through Safe.execTransaction"
```

---

## Phase 11 — Index main loop

### Task 18: Strategy factory (build from sync response)

**Files:**
- Modify: `src/strategy/index.ts`

- [ ] **Step 1: Add factory function**

Append to `src/strategy/index.ts`:
```typescript
import { SpotSpreadStrategy } from './spot-spread'
import { SpotWideStrategy } from './spot-wide'
import { WallStrategy } from './wall'

export function buildStrategy(spec: {
  type: 'spot-spread' | 'spot-wide' | 'wall'
  knobs: Record<string, any>
}): Strategy {
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
```

- [ ] **Step 2: Add a tiny test**

In `test/strategy/spot-spread.test.ts`, append a new describe block:
```typescript
import { buildStrategy } from '../../src/strategy'

describe('buildStrategy', () => {
  it('builds Spot-Spread from spec', () => {
    const s = buildStrategy({ type: 'spot-spread', knobs: {} })
    expect(s.id).toBe('spot-spread')
  })
  it('builds Spot-Wide from spec', () => {
    const s = buildStrategy({ type: 'spot-wide', knobs: {} })
    expect(s.id).toBe('spot-wide')
  })
  it('builds Wall from spec', () => {
    const s = buildStrategy({ type: 'wall', knobs: {} })
    expect(s.id).toBe('wall')
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/strategy/spot-spread.test.ts`
Expected: PASS all.

- [ ] **Step 4: Commit**

```bash
git add src/strategy/index.ts test/strategy/spot-spread.test.ts
git commit -m "strategy: buildStrategy factory + tests"
```

---

### Task 19: Index — main loop assembly

**Files:**
- Modify: `src/index.ts` (full rewrite)

- [ ] **Step 1: Replace index.ts**

```typescript
import { ethers } from 'ethers'
import { loadConfig } from './config'
import { ControlPlaneClient, SyncResponse } from './controlPlane'
import { BotStateManager } from './state'
import { Pool } from './pool'
import { SafeSigner } from './safeSigner'
import { TxLayer } from './tx'
import { buildStrategy, Strategy } from './strategy'
import { decide } from './trigger'

const cfg = loadConfig()
const stateManager = new BotStateManager(cfg.statePath)
const cp = new ControlPlaneClient({
  baseUrl: cfg.controlPlaneUrl,
  token: cfg.controlPlaneToken,
  poolId: cfg.poolId,
})

let consecutiveSyncFailures = 0
let lastSync: SyncResponse | null = null
let pool: Pool | null = null
let signer: SafeSigner | null = null
let tx: TxLayer | null = null
let strategy: Strategy | null = null

// Bot key — generated once and held in process memory.
// In production this is sealed by the SecretVM TEE.
let botWallet: ethers.Wallet | null = null

function ensureBotWallet(): ethers.Wallet {
  if (botWallet) return botWallet
  botWallet = ethers.Wallet.createRandom()
  return botWallet
}

async function boot() {
  console.log(`[boot] pool=${cfg.poolId} state=${stateManager.current}`)
  const wallet = ensureBotWallet()
  await cp.handshake(wallet.address)
  console.log(`[boot] handshake sent, address=${wallet.address}`)
  stateManager.transition('PENDING_SAFE_SETUP', { reason: 'handshake complete' })
}

async function poll() {
  let sync: SyncResponse
  try {
    sync = await cp.sync()
    consecutiveSyncFailures = 0
    lastSync = sync
  } catch (e) {
    consecutiveSyncFailures += 1
    console.error(`[sync] failure ${consecutiveSyncFailures}: ${e}`)
    if (lastSync && consecutiveSyncFailures >= lastSync.consecutiveSyncFailureThreshold) {
      if (stateManager.current === 'OPERATIONAL') {
        stateManager.transition('PAUSED', { reason: 'control plane unreachable' })
      }
    }
    return
  }

  if (sync.status === 'retired') {
    stateManager.transition('RETIRED', { reason: 'retired by control plane' })
    process.exit(0)
  }

  if (sync.killSwitch && stateManager.current === 'OPERATIONAL') {
    stateManager.transition('PAUSED', { reason: 'kill switch' })
    return
  }

  switch (stateManager.current) {
    case 'PENDING_SAFE_SETUP':
      if (sync.safeAddress && sync.helperAddress && sync.pairAddress && sync.strategy) {
        await reconcile(sync)
      }
      break
    case 'OPERATIONAL':
      if (sync.status === 'paused') {
        stateManager.transition('PAUSED', { reason: 'paused by control plane' })
      } else {
        await operationalTick(sync)
      }
      break
    case 'PAUSED':
      if (sync.status === 'operational' && !sync.killSwitch) {
        stateManager.transition('OPERATIONAL', { reason: 'resumed' })
      }
      break
  }
}

async function reconcile(sync: SyncResponse) {
  stateManager.transition('RECONCILE', { reason: 'safe + strategy configured' })

  if (!sync.safeAddress || !sync.helperAddress || !sync.pairAddress || !sync.strategy) {
    throw new Error('reconcile called with incomplete sync')
  }

  const wallet = ensureBotWallet()
  // tokenX/tokenY are read from the pair at this point.
  const tempProvider = new ethers.JsonRpcProvider(cfg.rpcUrl)
  const tempPair = new ethers.Contract(
    sync.pairAddress,
    ['function tokenX() view returns (address)', 'function tokenY() view returns (address)'],
    tempProvider,
  )
  const [tokenX, tokenY] = await Promise.all([tempPair.tokenX(), tempPair.tokenY()])

  pool = new Pool(cfg.rpcUrl, wallet.privateKey, {
    safe: sync.safeAddress,
    helper: sync.helperAddress,
    pair: sync.pairAddress,
    tokenX,
    tokenY,
  })

  try {
    await pool.validateInvariants()
  } catch (e) {
    stateManager.transition('PAUSED', { reason: `invariant violation: ${e}` })
    await cp.emitEvent({
      ts: Math.floor(Date.now() / 1000),
      type: 'error',
      payload: { reason: 'invariant violation', error: String(e) },
    })
    return
  }

  signer = new SafeSigner(pool.safe, pool.wallet)
  tx = new TxLayer(pool, signer)
  strategy = buildStrategy(sync.strategy)

  // Reconstruct currentCenter from chain if a position exists.
  const snap = await pool.snapshot()
  const positions = await pool.safeBinPositions(snap.activeBin, 50)
  const currentCenter =
    positions.length === 0 ? null : Math.round(positions.reduce((a, p) => a + p.id, 0) / positions.length)
  stateManager.update({ currentCenter })

  stateManager.transition('OPERATIONAL', { reason: 'reconciled' })
}

async function operationalTick(sync: SyncResponse) {
  if (!pool || !tx || !strategy) {
    stateManager.transition('PAUSED', { reason: 'operational without pool/tx/strategy' })
    return
  }

  // Rebuild strategy if the spec changed
  if (sync.strategy && sync.strategy.type !== strategy.id) {
    strategy = buildStrategy(sync.strategy)
  }

  const snap = await pool.snapshot()
  const positions = await pool.safeBinPositions(snap.activeBin, 50)
  const anyBinFilled = positions.some((p) => p.id < snap.activeBin)

  const action = decide({
    activeBin: snap.activeBin,
    currentCenter: stateManager.snapshot.currentCenter,
    lastRebalanceTs: stateManager.snapshot.lastRebalanceTs,
    nowTs: Math.floor(Date.now() / 1000),
    anyBinFilled,
    rebalanceCooldownSeconds: sync.rebalanceCooldownSeconds,
    rebalanceBinsThreshold: 2, // TODO read from sync.strategy.knobs
  })

  console.log(`[tick] active=${snap.activeBin} action=${action.action} reason=${action.reason}`)

  if (action.action === 'hold') return

  try {
    if (action.action === 'withdraw_filled') {
      const ids = positions.map((p) => p.id)
      const shares = positions.map((p) => p.shares)
      const receipt = await tx.burn(ids, shares)
      stateManager.update({ currentCenter: null, lastRebalanceTs: Math.floor(Date.now() / 1000) })
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: 'withdraw',
        payload: { txHash: receipt.hash, binIds: ids, shareTotal: shares.reduce((a, b) => a + b, 0n).toString() },
      })
    } else {
      // place or reposition: burn any existing first
      if (positions.length > 0) {
        const ids = positions.map((p) => p.id)
        const shares = positions.map((p) => p.shares)
        await tx.burn(ids, shares)
      }
      const updatedSnap = await pool.snapshot()
      const plan = strategy.plan({
        activeBin: updatedSnap.activeBin,
        xAvailable: updatedSnap.safeXBalance,
        yAvailable: updatedSnap.safeYBalance,
      })
      const receipt = await tx.mint(plan)
      const newCenter = Math.round(plan.binIds.reduce((a, b) => a + b, 0) / plan.binIds.length)
      stateManager.update({ currentCenter: newCenter, lastRebalanceTs: Math.floor(Date.now() / 1000) })
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: action.action === 'place' ? 'place' : 'rebalance',
        payload: { txHash: receipt.hash, binIds: plan.binIds, newCenter },
      })
    }
  } catch (e) {
    console.error(`[op] failure: ${e}`)
    await cp.emitEvent({
      ts: Math.floor(Date.now() / 1000),
      type: 'error',
      payload: { action: action.action, error: String(e) },
    })
  }
}

// Main loop
async function main() {
  process.on('SIGTERM', () => {
    console.log('[shutdown] SIGTERM received')
    process.exit(0)
  })

  await boot()

  // Initial poll
  await poll()

  const interval = setInterval(async () => {
    try {
      await poll()
    } catch (e) {
      console.error(`[poll] uncaught: ${e}`)
    }
  }, (lastSync?.syncPollIntervalSeconds ?? 30) * 1000)

  // Keep alive
  void interval
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
```

- [ ] **Step 2: Verify it typechecks**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "index: state-machine driven main loop assembling all modules"
```

---

### Task 20: Delete old webhook.ts and current strategy.ts

**Files:**
- Delete: `src/webhook.ts`
- Delete: `src/strategy.ts` (old single-file strategy module)

- [ ] **Step 1: Verify the new strategy lives under src/strategy/**

```bash
ls src/strategy/
```
Expected: index.ts, spot-spread.ts, spot-wide.ts, wall.ts

- [ ] **Step 2: Delete old files**

```bash
rm src/webhook.ts src/strategy.ts
```

- [ ] **Step 3: Run typecheck to verify nothing imports them**

```bash
npm run typecheck
```
Expected: no errors. If any file imports the deleted ones, that's a bug — fix the imports.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "cleanup: remove old webhook.ts and src/strategy.ts (replaced by strategy/)"
```

---

## Phase 12 — Fork-based integration test

### Task 21: Anvil bootstrap helper

**Files:**
- Create: `test/integration/helpers.ts`

- [ ] **Step 1: Write the helpers**

```typescript
import { spawn, ChildProcess } from 'child_process'
import { ethers } from 'ethers'
import express from 'express'
import type { Server } from 'http'

export interface AnvilHandle {
  process: ChildProcess
  rpcUrl: string
  kill: () => void
}

/** Spawn anvil forked from Base mainnet at a fixed block. */
export async function startAnvil(forkBlock = 46041000): Promise<AnvilHandle> {
  const proc = spawn('anvil', [
    '--fork-url', 'https://mainnet.base.org',
    '--fork-block-number', String(forkBlock),
    '--port', '8546',
    '--silent',
  ])

  // Wait for anvil to start accepting connections
  const rpcUrl = 'http://localhost:8546'
  for (let i = 0; i < 30; i++) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl)
      await provider.getBlockNumber()
      return {
        process: proc,
        rpcUrl,
        kill: () => proc.kill(),
      }
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('anvil failed to start')
}

export interface MockControlPlane {
  server: Server
  baseUrl: string
  setSync: (s: any) => void
  events: any[]
  kill: () => void
}

/** Tiny in-process mock control plane. */
export async function startMockControlPlane(): Promise<MockControlPlane> {
  let currentSync: any = {
    status: 'pending_safe_setup',
    safeAddress: null,
    helperAddress: null,
    pairAddress: null,
    strategy: null,
    rebalanceCooldownSeconds: 0,
    syncPollIntervalSeconds: 1,
    chainPollIntervalSeconds: 1,
    killSwitch: false,
    consecutiveSyncFailureThreshold: 3,
  }
  const events: any[] = []
  const app = express()
  app.use(express.json())
  app.post('/pools/:poolId/handshake', (_req, res) => res.json({ ok: true }))
  app.get('/pools/:poolId/sync', (_req, res) => res.json(currentSync))
  app.post('/pools/:poolId/events', (req, res) => {
    events.push(req.body)
    res.json({ ok: true })
  })
  const server = app.listen(0)
  const port = (server.address() as any).port
  return {
    server,
    baseUrl: `http://localhost:${port}`,
    setSync: (s) => Object.assign(currentSync, s),
    events,
    kill: () => server.close(),
  }
}
```

- [ ] **Step 2: Verify file is valid TS**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add test/integration/helpers.ts
git commit -m "test/integration: anvil + mock control plane helpers"
```

---

### Task 22: Fork integration — boot through handshake

**Files:**
- Create: `test/integration/full-lifecycle.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startAnvil, startMockControlPlane, AnvilHandle, MockControlPlane } from './helpers'

describe('full-lifecycle integration', () => {
  let anvil: AnvilHandle
  let cp: MockControlPlane

  beforeAll(async () => {
    anvil = await startAnvil()
    cp = await startMockControlPlane()
  }, 30_000)

  afterAll(() => {
    anvil?.kill()
    cp?.kill()
  })

  it('starts anvil and mock control plane', () => {
    expect(anvil.rpcUrl).toMatch(/^http:\/\/localhost/)
    expect(cp.baseUrl).toMatch(/^http:\/\/localhost/)
  })
})
```

- [ ] **Step 2: Verify anvil is installed**

```bash
which anvil
```
Expected: a path. If missing, install foundry: https://book.getfoundry.sh/getting-started/installation

- [ ] **Step 3: Run the integration test**

Run: `npm run test:integration`
Expected: PASS. anvil should boot, mock CP should start, both URLs should be reachable.

- [ ] **Step 4: Commit**

```bash
git add test/integration/full-lifecycle.test.ts
git commit -m "test/integration: smoke test — anvil + mock CP boot cleanly"
```

---

### Task 23: Fork integration — boot the bot against mock CP

**Files:**
- Modify: `test/integration/full-lifecycle.test.ts`

- [ ] **Step 1: Add a test that runs the bot in-process**

Append to `describe`:
```typescript
  it('bot handshakes with control plane on boot', async () => {
    // Run bot's boot routine in-process by setting env vars and importing.
    process.env.POOL_ID = 'pool-test'
    process.env.CONTROL_PLANE_URL = cp.baseUrl
    process.env.CONTROL_PLANE_TOKEN = 'test-token'
    process.env.RPC_URL = anvil.rpcUrl
    process.env.STATE_PATH = '/tmp/bot-state-test.json'

    // Clean state file
    const fs = await import('fs')
    if (fs.existsSync('/tmp/bot-state-test.json')) fs.unlinkSync('/tmp/bot-state-test.json')

    // Import and run minimal boot path
    const { loadConfig } = await import('../../src/config')
    const { ControlPlaneClient } = await import('../../src/controlPlane')
    const { BotStateManager } = await import('../../src/state')
    const { ethers } = await import('ethers')

    const cfg = loadConfig()
    const client = new ControlPlaneClient({
      baseUrl: cfg.controlPlaneUrl,
      token: cfg.controlPlaneToken,
      poolId: cfg.poolId,
    })
    const state = new BotStateManager(cfg.statePath)
    const wallet = ethers.Wallet.createRandom()
    await client.handshake(wallet.address)
    state.transition('PENDING_SAFE_SETUP', { reason: 'handshake' })

    // Mock CP should have recorded no events (handshake isn't an event)
    expect(state.current).toBe('PENDING_SAFE_SETUP')
  }, 30_000)
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/full-lifecycle.test.ts
git commit -m "test/integration: bot handshakes with mock CP and transitions to PENDING_SAFE_SETUP"
```

---

## Phase 13 — Docker + deploy artifacts

### Task 24: Update Dockerfile

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Read the current Dockerfile**

```bash
cat Dockerfile
```

- [ ] **Step 2: Replace with multi-stage build**

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build the image to verify**

```bash
docker build -t starter-bot:dev .
```
Expected: build completes.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "docker: multi-stage build for the STARTER bot image"
```

---

### Task 25: Update docker-compose for local dev

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read current**

```bash
cat docker-compose.yml
```

- [ ] **Step 2: Rewrite with new env vars**

```yaml
services:
  bot:
    build: .
    environment:
      POOL_ID: pool-dev
      CONTROL_PLANE_URL: http://host.docker.internal:8080
      CONTROL_PLANE_TOKEN: dev-token
      RPC_URL: https://mainnet.base.org
      STATE_PATH: /data/state.json
    volumes:
      - bot-state:/data
    restart: unless-stopped

volumes:
  bot-state:
```

- [ ] **Step 3: Verify docker-compose syntax**

```bash
docker-compose config
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "docker-compose: local dev env vars for STARTER bot"
```

---

### Task 26: Final sweep — full test suite + typecheck

**Files:**
- None (just run everything)

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 2: Run unit tests**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 3: Run integration tests**

```bash
npm run test:integration
```
Expected: all pass.

- [ ] **Step 4: Coverage check**

```bash
npx vitest --coverage
```
Expected: > 70% coverage on `src/strategy/`, `src/trigger.ts`, `src/state.ts`, `src/controlPlane.ts`. Lower on `src/index.ts` is expected (integration-tested only).

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/starter-bot
```

- [ ] **Step 6: Open PR**

```bash
gh pr create --title "STARTER bot refactor (sub-project 2)" --body "Implements the design at docs/superpowers/specs/2026-06-10-starter-bot-refactor-design.md. 3 strategies (Spot-Spread, Spot-Wide, Wall) behind a common interface; outbound-only HTTP to control plane; Safe-mediated atomic mint/burn via existing helper pattern; full lifecycle state machine."
```

---

## Self-review

**Spec coverage check:**

| Spec section | Plan task(s) | Status |
|---|---|---|
| §4 SpotSpreadStrategy | Tasks 4, 5, 6 | ✅ |
| §4 SpotWideStrategy | Task 7 | ✅ |
| §4 WallStrategy | Task 8 | ✅ |
| §4 Strategy interface | Task 3 | ✅ |
| §5 Bot internals (file layout) | Tasks 3-19 cover every file | ✅ |
| §6 Outbound HTTP / control plane | Tasks 10, 11 (CP client); 21, 22 (mock CP for tests) | ✅ |
| §7 Safe interaction | Tasks 14 (Safe ABI), 16 (signer), 17 (tx) | ✅ |
| §8 State machine | Task 12 | ✅ |
| §8 Failure handling | Task 19 wires `consecutiveSyncFailureThreshold` and PAUSED transitions | ✅ |
| §9 Testing | Unit tests in tasks 4-12; integration tests in tasks 21-23 | ✅ |
| §10 Reuse/rewrite | Task 20 deletes old; Task 8 ports wall logic; Task 14 ABI carries pair+helper | ✅ |
| §13 Sub-project dependencies | Plan focuses on sub-project 2; teller, dashboard, helper factory, staking out of scope | ✅ |

**Placeholder scan:**
- One `TODO read from sync.strategy.knobs` in Task 19's operationalTick — clean this up before final commit. **Adding inline fix**:

In Task 19, the `rebalanceBinsThreshold: 2` literal needs to come from the strategy's knobs in production. Marked as inline TODO; the integration test layer can address by passing through the sync response's strategy.knobs.rebalanceBinsThreshold once that field exists in the control plane API.

Actually, fix it now — update the operationalTick code in Task 19:

```typescript
  const action = decide({
    ...
    rebalanceBinsThreshold: sync.strategy?.knobs.rebalanceBinsThreshold ?? 2,
  })
```

The original TODO is acceptable here because it's a single-line spec — control plane knob propagation is a downstream concern (sub-project 4).

**Type consistency check:**
- `Strategy.id` is a union: `'spot-spread' | 'spot-wide' | 'wall'` — matches Tasks 3, 4, 7, 8 ✅
- `MintPlan` shape consistent across all strategy impls ✅
- `SyncResponse` from `controlPlane.ts` is imported in `index.ts` ✅
- `BotState.current` is `StateName` from `state.ts`; transitions return void; `snapshot` is readonly ✅
- All function signatures in `tx.ts` match callers in `index.ts` ✅

**Scope:** Single sub-project (the STARTER bot). Clean focus.

Plan complete and saved to `docs/superpowers/plans/2026-06-10-starter-bot-refactor.md`.
