# Strategy Weight Floor Design (fix bid-ask and curve LB v2 reverts)

**Date:** 2026-06-15
**Repos:** `dungeonclaw-pitbot` (primary) + `janus-app` (provision YAML bump only)
**Affects:** `src/strategy/bid-ask.ts`, `src/strategy/curve.ts`, their test files, `package.json` (version bump), `janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` (image tag bump).

## Problem

The first on-chain mint with the new `bid-ask` strategy reverted with Gnosis Safe `GS013` — Safe's catch-all for "the inner call reverted but I can't tell you why". The Safe is configured with `gasPrice=0` and `safeTxGas=0`, so its `execTransaction` swallows the real error.

Diagnosis: the per-bin distribution math is correct (verified against the on-chain calldata), but the innermost bin gets only 1/385 = **0.26%** of the total amount. LB v2 pairs revert when the shares calc for a bin rounds down to zero, which happens reliably below ~1% allocation per bin. The math is mathematically valid but operationally incompatible with LB v2's per-bin minimum-shares constraint.

The same shape problem affects `curve` (outermost bin gets 1/55 = 1.8%, sitting on the threshold) but spot-spread / spot-wide / spot-concentrated / wall are safe in their current configurations.

## Goals

- bid-ask and curve produce distributions where every nonzero bin gets **≥ ~2%** of total allocation per side.
- The U-shape (bid-ask) and bell-shape (curve) intent remain visually recognizable in the ShapeThumb and in the on-chain bin chart.
- A regression test enforces a per-bin minimum so future weight tweaks can't silently reintroduce the bug.
- Ship as `v0.1.14`, applied to all 3 live VMs via `secretvm-cli vm edit`.

## Non-goals

- Modifying spot-spread, spot-wide, spot-concentrated, or wall. None reported broken.
- Introducing new tunable knobs (bias values are hard-coded constants).
- Changing the `binCount` / `binsAbove` / `binsBelow` defaults.
- Changing the LB v2 mint path on the bot side. The fix is purely in the strategy plan output.

## Design

### Constants

Each affected strategy gets a single bias constant in its file:

```ts
// src/strategy/bid-ask.ts
const INNERMOST_BIAS = 10n
```

```ts
// src/strategy/curve.ts
const OUTERMOST_BIAS = 3n
```

These names reflect which side of the shape gets boosted (bid-ask's innermost bins, curve's outermost bins). Values chosen to push the smallest weight above the ≥ 2% threshold while preserving shape intent.

### bid-ask weight function

Replace:

```ts
function uShapeWeight(distanceFromActive: number): bigint {
  const d = BigInt(distanceFromActive + 1)
  return d * d
}
```

with:

```ts
function uShapeWeight(distanceFromActive: number): bigint {
  const d = BigInt(distanceFromActive + 1)
  return d * d + INNERMOST_BIAS
}
```

For `binsSide=10`:

| distance | weight (before) | weight (after) |
|---|---|---|
| 0 (innermost) | 1 | 11 |
| 1 | 4 | 14 |
| 2 | 9 | 19 |
| 3 | 16 | 26 |
| 4 | 25 | 35 |
| 5 | 36 | 46 |
| 6 | 49 | 59 |
| 7 | 64 | 74 |
| 8 | 81 | 91 |
| 9 (outermost) | 100 | 110 |
| **sum** | **385** | **485** |
| **smallest %** | **0.26%** | **2.27%** |
| **largest %** | **26.0%** | **22.7%** |

Still a clear U-shape; just less extreme.

### curve weight function

Replace:

```ts
function bellWeight(distanceFromActive: number, binsSide: number): bigint {
  const w = binsSide - distanceFromActive
  return w >= 1 ? BigInt(w) : 1n
}
```

with:

```ts
function bellWeight(distanceFromActive: number, binsSide: number): bigint {
  const w = binsSide - distanceFromActive
  return (w >= 1 ? BigInt(w) : 1n) + OUTERMOST_BIAS
}
```

For `binsSide=10`:

| distance | weight (before) | weight (after) |
|---|---|---|
| 0 (innermost) | 10 | 13 |
| 1 | 9 | 12 |
| 2 | 8 | 11 |
| 3 | 7 | 10 |
| 4 | 6 | 9 |
| 5 | 5 | 8 |
| 6 | 4 | 7 |
| 7 | 3 | 6 |
| 8 | 2 | 5 |
| 9 (outermost) | 1 | 4 |
| **sum** | **55** | **85** |
| **smallest %** | **1.82%** | **4.71%** |
| **largest %** | **18.2%** | **15.3%** |

Bell shape preserved with slightly compressed dynamic range.

### Test changes

Existing tests assert ordinal properties (e.g. "outermost > innermost" for bid-ask) which still hold under the new weights. Two changes needed per strategy:

1. **Update any numeric expectations** if a test pinned a specific distribution value. (Quick read suggests neither bid-ask.test.ts nor curve.test.ts pinned specific values — they assert sums == 1e18 and ordering only.)
2. **Add a min-distribution invariant test**:

```ts
it('every nonzero distribution value is at least 2% of ONE (LB v2 min-shares safety)', () => {
  const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
  const plan = strat.plan({
    activeBin: ACTIVE, xAvailable: ONE, yAvailable: ONE, binStep: 100,
  })
  const MIN = ONE / 50n  // 2%
  plan.distributionX.filter((d) => d > 0n).forEach((d) => {
    expect(d).toBeGreaterThanOrEqual(MIN)
  })
  plan.distributionY.filter((d) => d > 0n).forEach((d) => {
    expect(d).toBeGreaterThanOrEqual(MIN)
  })
})
```

Same shape for curve. This catches future regressions where someone tweaks the weight function and drops below the threshold.

### Rollout

1. `package.json` 0.1.13 → 0.1.14.
2. `docker build --platform linux/amd64 -t ghcr.io/electrickc/janus-starter-bot:v0.1.14 .` then `docker push`.
3. Update janus-app provision YAML: v0.1.13 → v0.1.14, commit, deploy.
4. `secretvm-cli vm edit -d <new-compose.yml> <vmId>` for all 3 live VMs (maroon-mandrill `cmqaod1dg00gmn0iqhcm2esrg`, salmon-guppy `cmq9zxfny00f4n0iq8c323d4n`, emerald-barracuda `cmqeyve41007e31iq25303h88`). Preserves `wallet.key` + `state.json`.
5. Verify with the `[reconcile] done in Nms` log marker. Then the user can let the pool tick and watch for a successful `[tick] action=place reason=no position present` followed by `[op] success` (not `[op] failure: ... GS013`).

## Out of scope (explicit)

- Surfacing the inner-call revert reason through the Safe so future GS013s show the real error. That's a tx-layer concern; separate spec.
- Making the bias values tunable via strategy knobs.
- Generalising the min-distribution invariant into a shared helper used by all strategies. Could do it later if a fifth strategy gets the same fix.
- Touching wall or spot-wide. Wall worked historically; spot-wide is at 2% uniform which appears to work. If either reverts, apply the same pattern.
