# Advanced Strategies Design (bid-ask, curve, spot-concentrated)

**Date:** 2026-06-15
**Repos:** `dungeonclaw-pitbot` (primary) + `janus-app` (provision YAML bump only)
**Affects:** New `src/strategy/bid-ask.ts`, `curve.ts`, `spot-concentrated.ts` in the pitbot. `src/strategy/factory.ts` and `package.json` modifications. New unit test files. One-line change to `janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` to bump the bot image to `v0.1.12`.

## Problem

The janus-app frontend (`StrategyChanger.tsx`) and the strategy edit endpoint (`/api/v1/pools/[id]/strategy`) both surface six strategy shapes for ADVANCED-tier pools: `spot-spread`, `spot-wide`, `wall`, `spot-concentrated`, `curve`, `bid-ask`. The pitbot's `src/strategy/factory.ts` only implements the first three. When an ADVANCED pool's strategy is set to one of the missing three, the bot's `buildStrategy()` call returns `undefined`, the operational tick fails the `!strategy` guard, and the bot transitions to `PAUSED` with reason `"operational without pool/tx/strategy"`. The bot stays paused indefinitely until the strategy is changed back to a supported one.

We hit this with Pool 1 (`maroon-mandrill`) when the user upgraded it to ADVANCED and selected `bid-ask`. Janus-app did the right thing (the tier validation passed); the gap is purely on the bot side.

## Goals

- Implement bid-ask, curve, and spot-concentrated in the pitbot following the existing strategy interface and patterns.
- Each strategy handles two-sided and one-sided (X-only / Y-only) inputs gracefully, matching the spot-spread fallback pattern.
- Publish a new bot image `v0.1.12` and apply it to the two live VMs via `secretvm-cli vm edit` (preserves wallet.key + state.json).
- Janus-app's provision route references the new image so future-provisioned pools get v0.1.12 by default.

## Non-goals

- No new strategy knobs are introduced in this round. The three new strategies use hard-coded distribution math (sensible defaults derived from LB v2.2 canon). Knob-tuning is a separate feature when needed.
- No changes to janus-app's strategy edit endpoint or tier validation — both are already correct.
- No frontend changes — ShapeThumb already renders the three thumbs (shipped earlier today).
- No retroactive fix for pools currently paused with an unsupported strategy. The user is pausing affected pools manually; once v0.1.12 is live on the VMs they can re-pick bid-ask / curve / spot-concentrated.

## Design

### Strategy interface

Each new strategy implements the existing `Strategy` interface from `src/strategy/index.ts`:

```ts
export interface Strategy {
  readonly id: 'spot-spread' | 'spot-wide' | 'wall' | 'spot-concentrated' | 'curve' | 'bid-ask'
  plan(input: PlanInput): MintPlan
}
```

Note: the `id` union type widens to all six. The same widening applies to `factory.ts`'s `spec.type` union.

`PlanInput` and `MintPlan` already exist and need no changes.

### `bid-ask.ts`

U-shape: capital concentrated at the outer bins, light in the middle. Mirrors the well-known LB v2.2 bid-ask shape.

Distribution algorithm (per side):
- Compute `weight(i) = (i + 1)^2` where `i` is the bin's distance from the active bin (0-indexed). Edge bins get the largest weight.
- `distribution[i] = weight(i) * ONE / sum(weights)`.
- Reconcile rounding into the OUTERMOST bin on each side (largest one — keeps the U sharp).

Hard-coded config:
```ts
interface BidAskConfig {
  binCount: 20         // total bins
  binsAbove: 10        // X side
  binsBelow: 10        // Y side
}
```

Knobs from the strategy payload are accepted but only `binCount`/`binsAbove`/`binsBelow` are read; any others are ignored.

One-sided fallback: same intent-based check as `spot-spread.ts`. If `xAvailable < binsAbove` → Y-only mode (filter to bins below active, distribute Y across them with the same U-shape weight applied to just the below-active half). If `yAvailable < binsBelow` → X-only mode (mirror).

### `curve.ts`

Bell-shape: capital concentrated near the active bin, tapering off toward the edges.

Distribution algorithm (per side):
- Compute `weight(i) = max(1, binsSide - i)` where `i` is distance from active (linear taper). Center-adjacent bin gets the largest weight; the outermost gets weight 1.
- `distribution[i] = weight(i) * ONE / sum(weights)`.
- Reconcile rounding into the INNERMOST bin (closest to active) — keeps the peak crisp.

Hard-coded config: same as bid-ask (`binCount=20`, `binsAbove=10`, `binsBelow=10`).

One-sided fallback: same pattern as spot-spread.

### `spot-concentrated.ts`

Tight uniform spread over a narrow band. Essentially `spot-spread` with smaller defaults — narrower range, tighter capital deployment.

Distribution algorithm: uniform (`weight(i) = 1` for all i), identical to spot-spread's two-sided math. The only difference is the narrower default `binCount=6`, `binsAbove=3`, `binsBelow=3`.

We do NOT just call `SpotSpreadStrategy` with smaller defaults under the hood — separate file keeps the `id` distinct and the future tuning surface independent (e.g. spot-concentrated might add a different fallback later without affecting spot-spread).

One-sided fallback: same pattern as spot-spread.

### `factory.ts` integration

Three new cases added to the switch. The `spec.type` parameter type widens:

```ts
export function buildStrategy(spec: {
  type: 'spot-spread' | 'spot-wide' | 'wall' | 'spot-concentrated' | 'curve' | 'bid-ask'
  knobs: Record<string, any>
}) {
  switch (spec.type) {
    case 'spot-spread': /* existing */
    case 'spot-wide':   /* existing */
    case 'wall':        /* existing */
    case 'spot-concentrated':
      return new SpotConcentratedStrategy({
        binCount:  spec.knobs.binCount  ?? 6,
        binsAbove: spec.knobs.binsAbove ?? 3,
        binsBelow: spec.knobs.binsBelow ?? 3,
      })
    case 'curve':
      return new CurveStrategy({
        binCount:  spec.knobs.binCount  ?? 20,
        binsAbove: spec.knobs.binsAbove ?? 10,
        binsBelow: spec.knobs.binsBelow ?? 10,
      })
    case 'bid-ask':
      return new BidAskStrategy({
        binCount:  spec.knobs.binCount  ?? 20,
        binsAbove: spec.knobs.binsAbove ?? 10,
        binsBelow: spec.knobs.binsBelow ?? 10,
      })
  }
}
```

The switch becomes exhaustive (all six cases covered). If a future strategy is added at the janus-app layer without a matching pitbot factory case, TypeScript's switch-exhaustiveness check will surface it.

### Distribution invariants

Each strategy's `plan()` must satisfy:

1. `binIds.length === distributionX.length === distributionY.length`.
2. `sum(distributionX) === ONE` whenever any bin has X liquidity (two-sided or X-only mode), and `== 0n` in Y-only mode.
3. Same for Y.
4. `amountX <= xAvailable` and `amountY <= yAvailable`.
5. No bin has both `distributionX[i] === 0n && distributionY[i] === 0n` — LB v2.2 mint reverts on phantom bins (we already learned this in `spot-spread.ts:46-52`).

The tests assert these invariants for each strategy.

## Testing

Unit tests live next to each strategy file, following the existing pattern at `test/strategy/<name>.test.ts`. Each new strategy gets a test file with:

- Two-sided happy path: returns a valid MintPlan with `sum(distributionX) === ONE`, `sum(distributionY) === ONE`, and the bin shape matches the strategy's intent (e.g. edges-heavier for bid-ask, center-heavier for curve).
- X-only fallback: input with `yAvailable === 0n`, asserts the returned plan filters to above-active bins and `sum(distributionX) === ONE`.
- Y-only fallback: mirror.
- Bin count invariants: `binIds.length === binCount` (or filtered count in one-sided mode).
- No phantom bins: every bin has either X or Y weight > 0.

Total: ~6 tests per strategy × 3 strategies = 18 new tests.

No integration tests in this round — the existing `test/integration/full-lifecycle.test.ts` covers the operational tick path; the new strategies plug into the same flow.

## Image bump and rollout

1. After the pitbot PR merges, bump `package.json` version from `0.1.11` → `0.1.12`.
2. Build + push: `docker build --platform linux/amd64 -t ghcr.io/electrickc/janus-starter-bot:v0.1.12 . && docker push ghcr.io/electrickc/janus-starter-bot:v0.1.12`.
3. Update janus-app's `src/app/api/v1/admin/pools/[id]/provision/route.ts` to reference `v0.1.12` in the inlined `DOCKER_COMPOSE_YAML`.
4. Apply to the two live VMs via `secretvm-cli vm edit -d <new-compose.yml> <vmId>` — same flow we used for `v0.1.11`. Preserves wallet.key + state.json.

The compose YAML pushed via `vm edit` is identical to v0.1.11's except the image tag.

## Out of scope (explicit)

- Per-strategy knob editing UI (e.g. let the user tune `concentration` for bid-ask). Future feature.
- A retroactive "set Pool 1's strategy back to spot-spread" admin action. The user is pausing affected pools manually for now.
- Changes to the existing 3 strategies' behavior. The new code touches only new files except for the factory switch.
- Janus-app schema `$type<>` cleanup. The existing `as any` in the strategy edit route still works; tightening it is a separate cleanup pass.
