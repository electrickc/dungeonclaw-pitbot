# Managed DLMM Pools — Design Doc

**Date:** 2026-06-09
**Status:** Draft — brainstorming output, awaiting user review before implementation planning
**Owner:** electric-kc

---

## 1. Motivation

DungeonClaw's PitBot lost 0.092 WETH (~$180) to an MEV vector on tx `0x2d161e81…`. Root cause: the Trader Joe LB v2.0 pair authenticates `mint()` / `burn()` input by **balance delta** on the pair, not by which caller funded the delta. The bot's two-tx flow (transfer → mint; transfer-shares → burn) left a window in which any third party could call `swap()` and pocket the orphan delta as their own input.

The fix already in flight is `PitBotHelper.sol` — a single-owner contract that bundles transfer+mint and transfer+burn into one atomic call, closing the window. That contract is built but undeployed, pending red-team review.

This design generalises that helper into a **multi-tenant product**: any token project can deploy a managed LP pool on top of a Trader Joe LB v2.0 pair, community LPs can deposit safely, and an automated bot manages the position. We sell two service tiers and earn revenue from a base subscription + a cut of accrued LP fees.

The MEV-safe wrapping pattern is the structural value proposition. Active management is the upsell.

## 2. Product One-Liner

**Managed, MEV-safe DLMM pools on Base.** Token projects spin up a pool around their TJ LB v2.0 pair. Community members and outside LPs deposit WETH and/or the project's token through our wrapper, receive a receipt token, and benefit from automated rebalancing. We host the management bots in SecretVM (TEE) so neither we nor the team can see operator keys or strategy state.

## 3. Target Users

- **Token projects on Base** — want LP infrastructure they don't have to build themselves. Get a managed pool, a discovery listing, and (optionally) active strategic LP management.
- **Community LP members of those projects** — want to LP into their favourite project's pool without engineering a CLMM strategy. Deposit, earn, redeem.
- **Outside LPs / yield seekers** — find pools via the discovery UI, deposit into the ones with the strategy/risk profile they want.
- **AI agents (via MCP on Base)** — can query pool state, position info, and (in ADVANCED) trigger rebalances on a user or team's behalf.

## 4. Scope

### In scope (this design)
- Per-team factory + wrapper contract on Base, on top of an existing TJ LB v2.0 pair
- ERC-20 receipt token per pool for pro-rata accounting
- Atomic MEV-safe mint/burn through the wrapper
- One-sided and two-sided LP deposits
- Fee skim at rebalance, split between platform and team
- Two service tiers: BASIC (1 SecretVM, 1 bot) and ADVANCED (2 SecretVMs, 2 bots)
- Default DLMM shape (Spot-Spread) for BASIC; full shape catalog (Spot variants, Curve, Bid-Ask) for ADVANCED
- Discovery UI: project listings, pool stats, deposit/withdraw flow
- MCP server: read-only for BASIC, action-enabled for ADVANCED
- Base monthly subscription to cover SecretVM hosting costs

### Explicitly out of scope (v1)
- We do **not** fork the TJ LB pair. Direct LPs on the underlying pair are unaffected by us.
- We do **not** tax direct-LP flow. Only LPs who go through our wrapper pay our fee.
- No on-chain governance. Platform parameters (fee bps, supported shapes, paused state) are set by a multisig.
- No upgrade proxy on the wrapper. v2 = new clones.
- No on-chain shape registry. Shapes live in the bot.
- No cross-chain. Base only.

## 5. The Two Tiers

### BASIC — "Automatic DLMM" — Price A

| | |
|---|---|
| **Infra** | 1 SecretVM, 1 bot (the DLMM bot) |
| **What the bot does** | Handles community deposits/withdrawals; mints into a default Spot-Spread shape (~20 bins around active price); re-centers on drift when active bin moves past a threshold |
| **Shape switching** | No |
| **Volatility awareness** | No |
| **Team config** | Minimal — fee bps and pair address set at deploy, that's it |
| **Platform fee bps** | Lower (e.g. 10% of accrued fees, settable per pool) |
| **Subscription** | Lower flat monthly (covers 1 SecretVM) |
| **Buyer** | New projects launching liquidity, teams that want a pool that "just works" |

### ADVANCED — "Automatic DLMM + Pool Rebalancing" — Price B (> A)

| | |
|---|---|
| **Infra** | 2 SecretVMs, 2 bots (DLMM bot + Rebalancing bot) |
| **DLMM bot** | Same as BASIC — handles all user-facing deposit/withdraw flow, executes rebalance instructions atomically through the wrapper |
| **Rebalancing bot (new)** | Reads market conditions (active bin movement, swap volume, realized volatility, optional team signals); decides when to rebalance, what shape, what range, what skew; issues rebalance instructions to the DLMM bot |
| **Shape switching** | Yes — bot picks from full Meteora catalog (Spot, Spot-Concentrated, Spot-Spread, Spot-Wide, Curve, Bid-Ask) per regime |
| **Range width** | Dynamic, scaled to volatility |
| **One-sided shapes** | Yes — sell wall above price, buy wall below, DCA in/out |
| **Team config** | Allowed shapes, volatility thresholds, rebalance cadence, wall behaviour — set off-chain in the rebalancing bot |
| **Platform fee bps** | Higher (e.g. 20% of accrued fees) |
| **Subscription** | Higher monthly (covers 2 SecretVMs + more compute) |
| **Buyer** | Established projects with active LP management needs, teams running defensive walls or fee-maximization strategies |

### What's identical across tiers

- Same wrapper contract code (one factory, one clone implementation, same Solidity)
- Same ERC-20 receipt token, same mint/burn/redeem math
- Same MEV-safe atomic execution path
- Same discovery listing surface
- Same MCP integration shape (BASIC is read-only, ADVANCED unlocks actions)

The contract is **tier-agnostic.** Tier is provisioned off-chain (one VM vs two, simple bot vs smart bot, fee bps setting). No tier-specific Solidity. This keeps the contract auditable.

## 6. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Discovery UI                            │
│  - Lists all deployed pools (read via factory + indexer)         │
│  - Per-pool stats: TVL, APR, current shape, recent rebalances    │
│  - Deposit/withdraw flow (routes through wrapper)                │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────┐         ┌──────────────────────────┐
│       MCP Server             │◀────────│  AI Agents (per user)    │
│  - Read pool & position info │         │  - Query / suggest /     │
│  - ADVANCED: trigger actions │         │    (ADVANCED) rebalance  │
└────────────────┬─────────────┘         └──────────────────────────┘
                 │
        on-chain reads / wrapper calls
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│   On-chain (Base)                                                │
│                                                                  │
│   ┌─────────────────────┐                                        │
│   │  Factory contract   │── deploys ──┐                          │
│   └─────────────────────┘             │                          │
│                                       ▼                          │
│   ┌─────────────────────────────────────────────────────┐        │
│   │  Per-team Wrapper Clone (one per TJ pair)           │        │
│   │  - holds pooled LB shares                           │        │
│   │  - issues ERC-20 receipt token                      │        │
│   │  - mintAtomic / burnAtomic / rebalanceAtomic        │        │
│   │  - redeem (pro-rata) for any holder                 │        │
│   │  - fee skim at rebalance                            │        │
│   │  - operator = team's DLMM bot wallet                │        │
│   └────────────────┬────────────────────────────────────┘        │
│                    │ calls                                       │
│                    ▼                                             │
│   ┌─────────────────────────────────────────────────────┐        │
│   │  Trader Joe LB v2.0 Pair (already deployed)         │        │
│   │  - permissionless, direct LPs unaffected            │        │
│   └─────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
                 ▲
                 │ tx submissions
                 │
┌────────────────┴─────────────────────────────────────────────────┐
│   Off-chain (SecretVM, per team)                                 │
│                                                                  │
│   ┌─────────────────────────────────────┐                        │
│   │  DLMM bot (BASIC + ADVANCED)        │                        │
│   │  - operator key (in TEE)            │                        │
│   │  - handles user mint/burn flow      │                        │
│   │  - executes rebalances              │                        │
│   └────────────────▲────────────────────┘                        │
│                    │ rebalance instructions                      │
│                    │ (only ADVANCED)                             │
│   ┌────────────────┴────────────────────┐                        │
│   │  Rebalancing bot (ADVANCED only)    │                        │
│   │  - reads market state               │                        │
│   │  - computes shape, range, skew      │                        │
│   │  - emits rebalance instruction      │                        │
│   └─────────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────┘
```

## 7. On-Chain Components

### 7.1 Factory contract

- One per chain (Base). Deployed once by the platform.
- Method: `deployPool(pair, receiptName, receiptSymbol, feeBps, platformFeeRecipient, teamFeeRecipient, operator)` — uses EIP-1167 minimal proxy to clone the wrapper. Records the new pool in an on-chain registry and emits a `PoolDeployed` event.
- Admin: platform multisig can pause new deployments, update the wrapper implementation address used for future clones (existing clones are immutable), update default platform fee parameters.

### 7.2 Wrapper Clone (vault)

Per-team, per-pair. Holds the pooled LB shares. The team's bot is the operator.

Core state:
- `pair` (immutable) — the TJ LB v2.0 pair
- `tokenX`, `tokenY` (immutable) — derived from pair
- `operator` — bot address; can call mint/burn/rebalance; set at deploy, change requires platform multisig + team co-signature
- `feeBps`, `platformFeeRecipient`, `teamFeeRecipient` — fee config
- ERC-20 receipt token state (totalSupply, balances) — represents pro-rata share of pool

Core methods:
- `deposit(amountX, amountY, minShares, deadline)` — user-facing. Pulls X and/or Y from caller. Atomically transfers to pair and calls `pair.mint()` with the wrapper's *current active shape* (set by the operator via `setPositionShape` after each rebalance, OR derived by reading the wrapper's current per-bin LB shares — implementation choice for the contract phase). Mints receipt token shares pro-rata to the share of pool value contributed. One-sided deposits supported (one of `amountX`, `amountY` can be zero); see §15 for the open question on one-sided share math.
- `redeem(shares, minAmountX, minAmountY, deadline)` — user-facing. Burns receipt tokens. Computes the user's pro-rata claim on every bin the wrapper holds shares in. Atomically burns those LB shares (via `safeBatchTransferFrom` to pair + `pair.burn()`). Returns X + Y to user.
- `rebalanceAtomic(burnIds, burnShares, mintIds, distX, distY)` — operator-only. Burns existing position, computes accrued fee delta (returned amounts minus expected principal), skims `feeBps` of the delta to platform + team recipients, re-mints into new shape. All in one tx.
- `setPositionShape(ids, distX, distY)` — operator-only. Records the *current* shape so `deposit` knows where to mint. Bot calls this immediately before opening a new shape.
- `sweep(token)` — operator-only escape hatch for stuck tokens (similar to PitBotHelper).

What the operator **cannot** do:
- Withdraw funds to themselves. No code path lets `operator` move X, Y, or LB shares to an address that isn't the pair, the user redeeming, or the configured fee recipients.
- Mint receipt tokens out of thin air. Receipt minting is gated on actually depositing X/Y and calling `pair.mint()` successfully.
- Change `feeBps` arbitrarily. Either immutable per pool, or capped by a `MAX_FEE_BPS` set in the factory.

### 7.3 ERC-20 receipt token

- One per pool, named per team (e.g. `dcDCLAW-WETH` for DungeonClaw's pool).
- Standard ERC-20: `transfer`, `approve`, etc. Composable elsewhere (collateral, secondary trading).
- Minted on `deposit`, burned on `redeem`.
- No tax, no rebase. Pure pro-rata claim.

### 7.4 Fee mechanism

Accrued LP fees on TJ LB v2.0 are not separately accounted — they are added to the bin reserves as swaps happen. So "fee accrued by the pool" = `burned_X + burned_Y - principal_X - principal_Y` at the moment of a rebalance.

At each `rebalanceAtomic` call:
1. Compute the principal (X + Y value the wrapper deposited into the bins being burned, tracked in storage on the previous mint).
2. Burn returns actual `outX`, `outY` from the pair.
3. Delta = (outX − principalX, outY − principalY) — may be negative if price moved against (IL), in which case skim 0.
4. If positive: skim `feeBps * delta / 10_000` to platform and team recipients (split per the pool's `platformFeeRecipient` / `teamFeeRecipient`).
5. Remaining (X, Y) is fed into `pair.mint()` for the new shape.

LPs effectively pay the platform/team cut **on the fee-yield portion only** — not on principal, not on IL losses.

## 8. Off-Chain Components

### 8.1 DLMM bot

Runs in SecretVM. Holds the operator key (TEE-sealed). Responsibilities:

- Watch the pair for active-bin moves; trigger re-center on drift past threshold (BASIC default rule).
- Watch the wrapper for user `deposit`/`redeem` calls — these are atomic on-chain and don't need bot intervention to be safe, but the bot indexes them for stats and discovery UI.
- Execute rebalance instructions: in BASIC the instruction is computed by this same bot; in ADVANCED it comes from the Rebalancing bot over a coordinated channel.
- Emit observability data (Prometheus-style metrics, structured logs) to the platform's monitoring stack.

This bot is a generalisation of the current PitBot codebase. Reusing `tx.ts` / `pool.ts` / `strategy.ts` patterns; replacing the hard-coded WETH/DCLAW pair with per-pool config.

### 8.2 Rebalancing bot (ADVANCED only)

Runs in a separate SecretVM. Does **not** hold the operator key. Responsibilities:

- Subscribe to on-chain events and indexer feeds for the pair.
- Compute volatility, recent volume, price drift, custom team signals.
- Decide rebalance parameters: shape ID, bin range, distribution arrays, optional skew.
- Send rebalance instructions to the DLMM bot over an authenticated TEE-to-TEE channel.
- Expose a config interface for the team to tune strategy parameters.

The instruction format is simple JSON over signed HTTPS: `{nonce, shape, mintIds, distX, distY, burnIds, burnShares, signature}`. DLMM bot verifies the signature is from the Rebalancing bot's attested TEE key before executing.

### 8.3 SecretVM hosting

- Each team gets a SecretVM workspace (1 VM for BASIC, 2 for ADVANCED).
- Platform handles deployment, attestation verification, monitoring, and upgrades.
- Bot keys are generated *inside* the TEE on first boot and never leave. Platform and team can both verify the attestation but cannot read the keys.
- Gas funding: bot wallet is funded by the team via the discovery UI; platform abstracts the top-up flow.

## 9. DLMM Shape Support

All shape logic lives in the bot. The wrapper contract only sees `mintIds[]`, `distributionX[]`, `distributionY[]` — same calldata pattern as TJ's `pair.mint()`.

Supported shapes (per Meteora taxonomy):
- **Spot-Spread** (BASIC default, ADVANCED option) — 20–30 bins, uniform
- **Spot-Concentrated** (ADVANCED) — 1–3 bins, uniform
- **Spot-Wide** (ADVANCED) — ~50 bins, uniform
- **Curve** (ADVANCED) — bell distribution, concentrated near midpoint
- **Bid-Ask** (ADVANCED) — inverse bell, heavier at edges
- **Wall** (ADVANCED, custom) — one-sided narrow range (PitBot's current strategy), sell-side above price or buy-side below

New shapes can be added by updating the bot. No contract changes needed.

Optional safety rails enforced on-chain:
- `MIN_BINS` and `MAX_BINS` per pool — operator can't suddenly concentrate everything in one bin and grief LPs.
- `MAX_DRIFT_FROM_ACTIVE` — operator can't mint a shape whose bins are far away from the current active bin (which would deposit at unfavourable rates).

These rails are stored on the clone at deploy and tunable only by platform multisig.

## 10. Fee Economics

Two revenue streams from each team:

**Stream 1 — Subscription (covers SecretVM hosting cost + margin).**
- BASIC: lower flat monthly (sized to cover 1 VM with margin)
- ADVANCED: higher flat monthly (covers 2 VMs + ops + margin)
- Billed off-chain (Stripe / crypto invoicing TBD)
- Pre-paid (no auto-pause if a payment misses, but pool can be removed from discovery after grace period)

**Stream 2 — Fee skim from wrapped LP flow.**
- Platform fee bps: 10% (BASIC) / 20% (ADVANCED) of accrued LP fees, initial values, tunable per pool by platform multisig within `MAX_FEE_BPS` (e.g. 30%)
- Team fee bps: configurable per pool by the team within `MAX_TEAM_FEE_BPS` (e.g. 10%) — this is the team taking a cut of their own community's LP yield
- Combined cut is capped — direct LPs always have a better fee posture if they want to skip our service, which is fine; we sell convenience + safety + management

Numbers in (e.g. …) are starting points for discussion — not binding.

## 11. Discovery UI

Web app, Base wallet connection. Reads from factory's pool registry and the per-pool wrapper contracts.

Pages:
- **Browse:** card grid of all deployed pools. Filter by token, tier (BASIC/ADVANCED), TVL, APR, current shape, recent rebalance frequency.
- **Pool detail:** the pool's stats, current shape, recent rebalance history, team description, deposit/withdraw widget.
- **Team admin:** for the team operator. Configure rebalance parameters, view per-pool stats, set fee splits within caps.
- **LP dashboard:** for any user — their positions across pools, accrued fees (estimated mark-to-market), recent activity.

## 12. MCP Integration

MCP server deployed alongside the discovery UI. Implements an MCP server that exposes:

**Read tools (BASIC + ADVANCED):**
- `list_pools(filter)` — discover pools
- `get_pool(address)` — details for one pool
- `get_position(pool, user)` — user's position info, current value, estimated APR
- `simulate_deposit(pool, amountX, amountY)` — what receipt-token share would a user get

**Action tools (ADVANCED only, gated by team or user auth):**
- `propose_rebalance(pool, shape, params)` — team-only; queues a rebalance for the rebalancing bot to act on
- `set_strategy(pool, config)` — team-only; updates the rebalancing bot's strategy parameters

The MCP server has read access to the chain. Action calls go to the team's Rebalancing bot, not directly to the chain — so the bot can validate before acting.

## 13. Trust & Security

### Threat model

1. **MEV bot picks off pool funds.** Closed structurally by atomic mint/burn through the wrapper. The original vector is impossible because there is no inter-tx window where the pair holds funds without an accompanying mint/burn call.
2. **Bot operator key compromised.** Contract enforces: operator can only call `mintAtomic` / `burnAtomic` / `rebalanceAtomic` / `setPositionShape` / `sweep(stuckToken)`. No method moves X/Y/shares to an attacker-controlled address. Worst case: attacker can grief by repeatedly rebalancing into bad shapes; users can `redeem` at any time pro-rata of current bin reserves and exit.
3. **Wrapper contract bug.** All funds are potentially at risk. Mitigated by: (a) keeping the contract as small as possible — target ~400 LoC; (b) thorough red-team before deploy; (c) external audit before mainnet; (d) per-team clones (one team's pool ≠ another's blast radius).
4. **Platform (us) goes rogue.** Platform multisig can't withdraw user funds — it has no operator role on the clones. Platform multisig CAN: tune `feeBps` (within cap), pause new deployments, replace the wrapper implementation for *future* clones (existing ones immutable). Existing LPs always have `redeem()`. Platform fee accumulates only via the legitimate skim flow.
5. **Team goes rogue.** Team operator can rebalance into pathological-but-within-rails shapes (e.g. a shape that earns no fees, or that maximises IL for current price action). They cannot drain. `MIN_BINS` / `MAX_BINS` / `MAX_DRIFT_FROM_ACTIVE` rails limit the worst extremes but cannot guarantee a "good" shape. LPs can `redeem` at any time at the current bin reserves; the UI surfaces recent rebalance frequency and shape history so LPs can see if a team is misbehaving.
6. **SecretVM attestation broken.** TEE compromise reveals operator keys. Mitigated by attestation verification + key rotation flow + the fact that on-chain enforcement constrains operator power even with a leaked key.

### Audit scope

The wrapper contract is the critical asset. Estimated audit: 3–4 weeks external + 1–2 weeks internal red-team. Factory is much smaller and reviewed alongside.

## 14. Sub-projects (decomposition)

This design is too large for one implementation plan. It decomposes into:

1. **Wrapper contract + factory + receipt token** (Solidity, in `dungeonclaw-contracts`). Smallest critical-asset surface. Build first.
2. **Generalised DLMM bot** (refactor `dungeonclaw-pitbot` to be per-pool config-driven). Build in parallel with (1).
3. **Rebalancing bot** (new repo, ADVANCED tier). Build after (2) is stable.
4. **SecretVM multi-tenant hosting infra** (deployment scripts, attestation registry, billing hooks).
5. **Discovery UI** (new web app, probably in `dungeonclaw-admin` or a new repo).
6. **MCP server** (new, alongside discovery UI).
7. **Billing + onboarding flow.**

Each gets its own implementation plan via `superpowers:writing-plans`. We tackle (1) first as the critical-path security item.

## 15. Risks & Open Questions

- **Subscription billing tech stack** — Stripe? Crypto-native? Hybrid? Affects which compliance regimes we touch.
- **Fee bps starting values** — 10% / 20% are guesses. Need market research on competing managed-LP products before committing.
- **Initial set of supported shapes for ADVANCED** — full Meteora catalog is ambitious. May start with Spot-Spread + Curve + Bid-Ask + Wall, add others later.
- **What happens to existing LPs when platform replaces the implementation for future clones** — existing clones are immutable by design, so nothing. But this means we cannot patch a clone with a vuln post-deploy; we'd have to coordinate a migration. Acceptable for v1 — confirm with stakeholders.
- **TEE-to-TEE coordination between DLMM and Rebalancing bot** — needs an authenticated channel design. SecretVM may have native primitives for this; verify.
- **Direct-LP cannibalisation** — direct LPs on the underlying TJ pair don't pay us anything. Our pitch has to make wrapped LP strictly better (safety, automation, discovery, MCP) than direct LP. This is a product-marketing problem more than a technical one.
- **Liquidity fragmentation between wrapped and direct LP** — we're adding LP that lives "above" the pair via the wrapper. Wrapped LB shares and direct LB shares both consume the same bin reserves on the pair; no fragmentation at the swap-pricing level. Confirmed safe.
- **One-sided deposit share math.** When a user deposits only WETH (which mints into bins below active price) or only the project token (above active price), how is their "share of pool value" computed for receipt minting? Naively valuing the deposit at active-bin price under-weights the LP if their side later moves into the money. Two reasonable approaches: (a) value all assets at active price at deposit time (simple, slight unfairness either direction); (b) issue receipt tokens that are *bin-aware* and redeem the depositor's specific bin contribution back at exit. (b) is more correct but breaks the "pure ERC-20" composability story. Decide in the contract implementation plan.
- **Per-pool position-shape state vs derive-from-LB-shares.** Two impl choices for letting `deposit` know where to mint: store the active shape in contract storage (operator sets via `setPositionShape`), or compute by querying the wrapper's current LB shares per bin. The first is simpler and cheaper to call but adds a privileged setter; the second is more elegant and avoids drift between recorded and actual state. Decide in the contract implementation plan.

---

**Status note:** this design captures the *product* and the *contract-level architecture*. Implementation details for each sub-project (Solidity code structure, bot internals, UI framework, MCP wire format) belong in the per-sub-project implementation plans, not here.
