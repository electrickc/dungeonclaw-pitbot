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
| **Infra** | 1 SecretVM (smaller power tier), 1 bot (the DLMM bot) |
| **What the bot does** | Handles community deposits/withdrawals; mints into a default Spot-Spread shape (~20 bins around active price); re-centers on drift when active bin moves past a threshold |
| **Shape switching** | No |
| **Volatility awareness** | No |
| **Rebalance after directional move** | Mints into whatever shape the post-burn asset mix allows. If burn returns mostly one asset (because price trended in one direction and the other side got consumed), the bot re-mints a **one-sided shape** — sell wall above active when holding token, buy wall below active when holding WETH. **No swap-to-rebalance.** Honest CLMM-native behaviour: when/if price reverts, the one-sided position consumes back into balance. |
| **Team config** | Minimal — fee bps and pair address set at deploy, that's it |
| **Platform fee bps** | Lower (e.g. 10% of accrued fees, settable per pool) |
| **Subscription** | Lower flat monthly (covers 1 small SecretVM) |
| **Buyer** | New projects launching liquidity, teams that want a pool that "just works" |

### ADVANCED — "Automatic DLMM + Pool Rebalancing" — Price B (> A)

| | |
|---|---|
| **Infra** | 1 SecretVM (larger power tier), 2 engines in one enclave: **DLMM engine** + **Rebalancing engine**, sharing the operator key, communicating via local IPC |
| **DLMM engine** | Same as BASIC's bot — handles all user-facing deposit/withdraw flow, executes rebalance instructions atomically through the wrapper |
| **Rebalancing engine (new, ADVANCED only)** | Reads market conditions (active bin movement, swap volume, realized volatility, optional team signals); decides when to rebalance, what shape, what range, what skew; hands rebalance instructions to the DLMM engine via local IPC inside the same enclave |
| **Shape switching** | Yes — engine picks from full Meteora catalog (Spot, Spot-Concentrated, Spot-Spread, Spot-Wide, Curve, Bid-Ask) per regime |
| **Range width** | Dynamic, scaled to volatility |
| **One-sided shapes** | Yes — sell wall above price, buy wall below, DCA in/out |
| **Rebalance after directional move** | Rebalancing engine **chooses** among: (a) re-mint one-sided (same as BASIC, when conviction is "price will revert"); (b) **swap-to-rebalance** via the pair, paying the swap cost to restore a two-sided position (when conviction is "price has moved permanently, capture fees both ways at the new level"); (c) wait — skip the rebalance entirely if neither is justified. Decision governed by strategy params the team sets off-chain. |
| **Team config** | Allowed shapes, volatility thresholds, rebalance cadence, swap-rebalance policy, wall behaviour — set off-chain in the rebalancing engine |
| **Platform fee bps** | Higher (e.g. 20% of accrued fees) |
| **Subscription** | Higher monthly (covers 1 large SecretVM + strategy ops) |
| **Buyer** | Established projects with active LP management needs, teams running defensive walls or fee-maximization strategies |

### Why ADVANCED — the fee opportunity LPs are paying for

TJ LB v2.0's swap fee on a pool combines a **base fee** (`baseFactor × binStep`, set per pool at deploy) and a **variable fee** that surges with realized volatility (capped at 10% protocol-wide via `MAX_FEE`). On a high-binstep volatile pair like DCLAW/WETH (binStep=240), combined fees can spike to **~6% per swap during volatility surges** — that is the LP yield ADVANCED's rebalancing engine is trying to maximise capture of. (Exact peak depends on the deployed pair's `baseFactor` and observed volatility; verify against on-chain config before quoting hard numbers to customers.)

Why active rebalancing captures more of that yield than BASIC's passive re-centering:

1. **Stay in range during volatility surges.** When the variable fee is high (volatility is high), active rebalancing re-mints around the new active price *quickly*. Passive re-centering may lag, leaving liquidity in stale bins that earn nothing during the surge.
2. **Stay two-sided during sustained trends.** Once price has clearly moved to a new level, swap-to-rebalance restores fee capture on *both* directions of wobble around the new level. Passive one-sided positions only earn on a reversion that may not come for hours or days.
3. **Switch shape to the regime.** Calm market: Curve (concentrated near active price, max fee density). Volatile: Spot-Wide (durable through the storm). Sustained one-way: Bid-Ask one-sided (maximum yield from the breakout). Picking the right shape per regime is the rebalancing engine's job.

Net effect: in volatile markets ADVANCED earns materially more fees than BASIC for the same TVL, and the cost difference (larger VM + higher platform bps) is justified by the extra capture. In quiet markets the gap narrows and BASIC is the rational choice.

### Why one larger SecretVM, not two

Both engines run in the **same enclave**, share the **same operator key**, and communicate via **local IPC** — not a TEE-to-TEE channel. The reasoning:

- Two enclaves with two keys does not add real security — both bots are in the same trust domain (yours), and an enclave compromise that exfiltrates one key would likely exfiltrate the other too. The "2 SecretVMs" framing was security theatre.
- Local IPC is faster, simpler, and has no signature-verification surface to get wrong.
- SecretVM offers three power tiers; BASIC uses the smaller, ADVANCED the larger. The cost differential between tiers is what we pass through in pricing — **honest infra cost + margin, not invented headcount of VMs**.
- One enclave = one attestation surface to verify, one log to monitor, one upgrade cadence.

### What's identical across tiers

- Same wrapper contract code (one factory, one clone implementation, same Solidity)
- Same ERC-20 receipt token, same mint/burn/redeem math
- Same MEV-safe atomic execution path
- Same discovery listing surface
- Same MCP integration shape (BASIC is read-only, ADVANCED unlocks actions)

The contract is **tier-agnostic.** Tier is provisioned off-chain (smaller VM vs larger VM, simple bot vs strategy engine, fee bps setting). No tier-specific Solidity. This keeps the contract auditable.

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
│   Off-chain (one SecretVM per team)                              │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │  SecretVM enclave (smaller tier = BASIC, larger = ADV)   │   │
│   │  - operator key born inside enclave, sealed              │   │
│   │  - shared by all engines in this enclave                 │   │
│   │                                                          │   │
│   │  ┌──────────────────────────────┐                        │   │
│   │  │  DLMM engine                 │                        │   │
│   │  │  (BASIC + ADVANCED)          │                        │   │
│   │  │  - handles user deposit/redeem│                       │   │
│   │  │  - executes rebalances        │                       │   │
│   │  │  - BASIC: re-center on drift  │                       │   │
│   │  └──────────────▲───────────────┘                        │   │
│   │                 │ local IPC                              │   │
│   │                 │ (in-enclave, no TEE-to-TEE)            │   │
│   │  ┌──────────────┴───────────────┐                        │   │
│   │  │  Rebalancing engine          │                        │   │
│   │  │  (ADVANCED only)             │                        │   │
│   │  │  - reads market state        │                        │   │
│   │  │  - picks shape, range, skew  │                        │   │
│   │  │  - may swap-to-rebalance     │                        │   │
│   │  └──────────────────────────────┘                        │   │
│   └──────────────────────────────────────────────────────────┘   │
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

The wrapper takes a **performance fee on realized LP yield, denominated in WETH only**, charged at two moments: at every rebalance (on aggregate pool yield since the last rebalance), and at every redeem (on the redeeming user's untaxed yield since their last rebalance touchpoint). The two charge points are designed so no value is taxed twice and no value escapes a skim.

#### State

- `hwmPerShare` (pool-level) — value-per-share in WETH terms after the most recent rebalance skim. Initialised to the value-per-share of the first deposit.
- `costBasisPerShare[user]` (per user) — user's weighted-average value-per-share at deposit time. Updated on each deposit: `newBasis = (oldBasis × oldShares + currentVPerShare × newShares) / (oldShares + newShares)`.

#### At `rebalanceAtomic`

1. Burn current position. Pair returns `(outX, outY)`.
2. Value pool in WETH: `totalValue = outY + outX × activeBinPrice` (X = project token, Y = WETH).
3. `currentVPerShare = totalValue / receiptTotalSupply`.
4. If `currentVPerShare > hwmPerShare`:
   - `skimPerShare = feeBps × (currentVPerShare − hwmPerShare) / 10_000`
   - `skimTotal = skimPerShare × receiptTotalSupply` (in WETH)
   - Pay the skim out of `outY`; if `outY < skimTotal`, swap a small amount of `outX → Y` on the pair to satisfy WETH denomination (the swap pays TJ's swap fee — acceptable cost, infrequent in practice since burns typically return some WETH)
   - Transfer the skim split per pool config to `platformFeeRecipient` / `teamFeeRecipient`
   - Update `hwmPerShare = currentVPerShare − skimPerShare`
5. Re-mint the remaining `(outX − feeXPortion, outY − feeYPortion)` into the new shape.

#### At `redeem`

1. User burns `userShares` receipt tokens. Wrapper burns the user's pro-rata LB shares on the pair, gets `(redeemX, redeemY)`.
2. `userValue = redeemY + redeemX × activeBinPrice` in WETH.
3. `userValuePerShare = userValue / userShares`.
4. **Effective basis** prevents double-taxation: `effectiveBasis = max(costBasisPerShare[user], hwmPerShare)`. Anything below HWM was already taxed at the last rebalance. Anything between basis and HWM that the user benefited from has already been paid for via the rebalance skim.
5. `userYieldPerShare = max(0, userValuePerShare − effectiveBasis)`.
6. `userFee = feeBps × userYieldPerShare × userShares / 10_000` (in WETH).
7. If `userFee > 0`, hold back from `redeemY` and transfer to recipients per pool config (same swap-fallback as rebalance if WETH is insufficient).
8. Send `(redeemX − feeXPortion, redeemY − feeYPortion)` to the user.

#### Why this is correct

- **Rebalance skim** taxes aggregate yield since the last rebalance, pool-level, and updates HWM.
- **Redeem skim** uses `effectiveBasis = max(costBasis, HWM)` so the *taxable region* per user is always `(effectiveBasis → current)`. Region below HWM was paid pro-rata at the rebalance; region below personal basis is loss territory (capped at zero).
- A user who deposited *above* HWM (after appreciation, before next rebalance) has `costBasis > HWM`. On redeem, they pay from `costBasis` up. No double-pay.
- A user who deposited *below* HWM and was in-pool at the prior rebalance had their share of the rebalance skim contributed already. On redeem, they pay only from `HWM` up — the basis→HWM portion was already settled.

#### Acknowledged limitation: late-depositor gap

If User B deposits when pool value has appreciated from HWM=1.0 to V=1.2 (no rebalance yet), B's basis = 1.2. On the *next* rebalance, the pool-level skim taxes the aggregate gain from HWM=1.0 to V=1.2 pro-rata across **all** holders including B. B effectively contributes to a fee on a gain B did not earn. Mitigated by the bot rebalancing often (drift-based + ADVANCED active strategy) so the HWM-to-current gap stays small (≤1-2% under normal conditions). This is the standard performance-fee vault pattern (Yearn, etc.) and we accept it for v1 rather than over-engineer per-user HWM accounting.

## 8. Off-Chain Components

### 8.1 DLMM engine

Runs inside the SecretVM enclave. Holds the operator key (TEE-sealed). Present in both tiers. Responsibilities:

- Watch the pair for active-bin moves. In BASIC, trigger re-center on drift past threshold. In ADVANCED, defer trigger decisions to the Rebalancing engine.
- Watch the wrapper for user `deposit`/`redeem` calls — these are atomic on-chain and don't need engine intervention to be safe, but the engine indexes them for stats and the discovery UI.
- Execute rebalance instructions atomically through the wrapper. In BASIC the instruction is computed by this engine itself. In ADVANCED it arrives over local in-enclave IPC from the Rebalancing engine.
- For BASIC's post-burn one-sided case: re-mint the appropriate one-sided shape (sell-wall / buy-wall) at the new center using whatever asset mix the burn returned.
- Emit observability data (Prometheus-style metrics, structured logs) to the platform's monitoring stack.

This engine is a generalisation of the current PitBot codebase. Reuses `tx.ts` / `pool.ts` / `strategy.ts` patterns; replaces the hard-coded WETH/DCLAW pair with per-pool config.

### 8.2 Rebalancing engine (ADVANCED only)

Runs **in the same SecretVM enclave** as the DLMM engine — separate process, separate codebase, same trust boundary. Shares the operator key indirectly (it does not call the wrapper itself; it hands instructions to the DLMM engine, which holds the signing key). Communicates via local Unix-domain socket or shared-memory channel inside the enclave — **no TEE-to-TEE channel, no external signature verification**. Responsibilities:

- Subscribe to on-chain events and indexer feeds for the pair.
- Compute volatility, recent volume, price drift, custom team signals.
- Decide rebalance parameters: shape ID, bin range, distribution arrays, optional skew, swap-to-rebalance amount + direction.
- Hand rebalance instructions to the DLMM engine.
- Expose a config interface for the team to tune strategy parameters (allowed shapes, volatility thresholds, rebalance cadence, swap-rebalance policy).

Instruction format is an in-process struct, not a wire format. Privilege gating is by Unix process ownership inside the enclave (both engines run under the same user, both inside the same attested TEE).

### 8.3 SecretVM hosting

- Each team gets exactly **one** SecretVM enclave. BASIC provisions the smaller power tier; ADVANCED provisions the larger one. (SecretVM offers three power tiers — BASIC sits at the smallest sufficient for the DLMM engine; ADVANCED steps up to handle the strategy compute on top of it.)
- Platform handles deployment, attestation verification, monitoring, and upgrades.
- Operator key is generated *inside* the TEE on first boot and never leaves. Platform and team can both verify the attestation but cannot read the key.
- Gas funding: operator wallet is funded by the team via the discovery UI; platform abstracts the top-up flow.

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
- BASIC: lower flat monthly (sized to cover the smaller SecretVM tier + monitoring + margin)
- ADVANCED: higher flat monthly (sized to cover the larger SecretVM tier + strategy ops + margin)
- The delta between tiers ≈ SecretVM tier price delta + ops overhead — honest infra cost pass-through, not invented headcount of VMs
- Billed off-chain (Stripe / crypto invoicing TBD)
- Pre-paid (no auto-pause if a payment misses, but pool can be removed from discovery after grace period)

**Stream 2 — Fee skim from wrapped LP flow.**
- Performance fee on LP yield only — never on principal, never on losses. WETH-denominated. See §7.4 for the exact HWM + cost-basis mechanism.
- Charged at both rebalance time (aggregate, pool-level) and redeem time (per-user, untaxed-yield-only). Two charge points are designed to never double-tax.
- Platform fee bps: 10% (BASIC) / 20% (ADVANCED) of taxable yield, initial values, tunable per pool by platform multisig within `MAX_FEE_BPS` (e.g. 30%)
- Team fee bps: configurable per pool by the team within `MAX_TEAM_FEE_BPS` (e.g. 10%) — team's cut of their own community's LP yield
- Both platform and team get paid in WETH, on-chain, directly to their configured recipient addresses (multisig or EOA) on every rebalance and redeem
- Combined cut is capped — direct LPs on the underlying pair always have a better fee posture if they want to skip our service. We sell convenience + safety + management, not cheaper fees

Numbers in (e.g. …) are starting points for discussion — not binding.

## 11. Discovery UI

Web app, Base wallet connection. Reads from factory's pool registry and the per-pool wrapper contracts.

Pages:
- **Browse:** card grid of all deployed pools. Filter by token, tier (BASIC/ADVANCED), TVL, APR, current shape, recent rebalance frequency.
- **Pool detail:** the pool's stats, current shape, recent rebalance history, team description, deposit/withdraw widget.
- **Team admin:** for the team operator. Configure rebalance parameters, view per-pool stats, set fee splits within caps.
- **LP dashboard:** for any user — their positions across pools, accrued fees (estimated mark-to-market), recent activity.

## 12. MCP Integration

We deploy a **Janus MCP server** alongside the discovery UI that exposes our pools as MCP tools, so AI agents on Base can discover, inspect, simulate, and (for teams) trigger actions against the pools.

**Read tools (BASIC + ADVANCED):**
- `list_pools(filter)` — discover pools
- `get_pool(address)` — details for one pool
- `get_position(pool, user)` — user's position info, current value, estimated APR
- `simulate_deposit(pool, amountX, amountY)` — what receipt-token share would a user get

**Action tools (ADVANCED only, gated by team or user auth):**
- `propose_rebalance(pool, shape, params)` — team-only; queues a rebalance instruction for the team's Rebalancing engine to evaluate and (if accepted) act on
- `set_strategy(pool, config)` — team-only; updates the team's Rebalancing engine strategy parameters

The Janus MCP server has read access to Base via direct RPC. Action calls are forwarded to the team's enclave (which terminates inside the Rebalancing engine), so the engine can validate them against its policy before the DLMM engine submits the tx. The MCP server itself never holds operator keys.

### Relationship to Base MCP

"Base MCP" — the broader ecosystem of MCP servers exposing Base chain (Coinbase's reference server + community ones) — is **adjacent infrastructure** we ride and extend, not infrastructure we build on:

- **Inside the Rebalancing engine: no MCP.** Strategy decisions use deterministic code with direct RPC reads. LLM-mediated reads via MCP would add latency, a query-translation surface, and non-determinism to a process that moves user money. Strategy code stays auditable.
- **Tool-schema convention: borrow from Base MCP.** Where Coinbase's Base MCP server already defines a tool shape (e.g. how a balance lookup is named/parametrised), we mirror it so agents already trained against Base MCP find our Janus tools familiar.
- **Discoverability: ride the protocol.** Agents configured to talk to Base MCP servers will find ours natural; we benefit from the existing agent-side adoption.
- **Optional future:** an LLM-driven strategy variant of the Rebalancing engine could consume Base MCP for reads as a research direction — not v1.

Net: Janus MCP **extends** the Base agent toolset; the Rebalancing engine **does not depend on** Base MCP.

## 13. Trust & Security

### Threat model

1. **MEV bot picks off pool funds.** Closed structurally by atomic mint/burn through the wrapper. The original vector is impossible because there is no inter-tx window where the pair holds funds without an accompanying mint/burn call.
2. **Bot operator key compromised.** Contract enforces: operator can only call `mintAtomic` / `burnAtomic` / `rebalanceAtomic` / `setPositionShape` / `sweep(stuckToken)`. No method moves X/Y/shares to an attacker-controlled address. Worst case: attacker can grief by repeatedly rebalancing into bad shapes; users can `redeem` at any time pro-rata of current bin reserves and exit.
3. **Wrapper contract bug.** All funds are potentially at risk. Mitigated by: (a) keeping the contract as small as possible — target ~400 LoC; (b) thorough red-team before deploy; (c) external audit before mainnet; (d) per-team clones (one team's pool ≠ another's blast radius).
4. **Platform (us) goes rogue.** Platform multisig can't withdraw user funds — it has no operator role on the clones. Platform multisig CAN: tune `feeBps` (within cap), pause new deployments, replace the wrapper implementation for *future* clones (existing ones immutable). Existing LPs always have `redeem()`. Platform fee accumulates only via the legitimate skim flow.
5. **Team goes rogue.** Team operator can rebalance into pathological-but-within-rails shapes (e.g. a shape that earns no fees, or that maximises IL for current price action). They cannot drain. `MIN_BINS` / `MAX_BINS` / `MAX_DRIFT_FROM_ACTIVE` rails limit the worst extremes but cannot guarantee a "good" shape. LPs can `redeem` at any time at the current bin reserves; the UI surfaces recent rebalance frequency and shape history so LPs can see if a team is misbehaving.
6. **SecretVM attestation broken.** TEE compromise reveals the operator key. One enclave per team means one attestation surface to defend per team (not two), and one key to rotate if leakage is suspected. Mitigated by attestation verification, a key-rotation flow (rotate the wrapper's operator address via the multisig + team co-sign path), and the fact that on-chain rails constrain operator power even with a leaked key — worst case the attacker can grief via bad rebalances, but cannot drain.

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
- **SecretVM power tier sizing.** SecretVM offers three power tiers; we need to characterise CPU/RAM needs of the DLMM engine alone vs DLMM + Rebalancing combined to pick the right tier for BASIC and ADVANCED. Affects subscription pricing.
- **Swap-to-rebalance policy and slippage controls (ADVANCED).** When the Rebalancing engine decides to swap to restore balance, what's the safe slippage cap, max swap size per cycle, and cooldown? These need defaults + team-tunable bounds. Decide in the Rebalancing engine implementation plan.
- **Verify TJ LB v2.0 fee math against the deployed DCLAW/WETH pair.** The "~6% during volatility surges" figure is derived from `baseFee = baseFactor × binStep` + variable fee (capped at 10% MAX_FEE protocol-wide). Need to read the deployed pair's `baseFactor` and observed variable-fee history to validate the number before quoting it to customers.
- **Direct-LP cannibalisation** — direct LPs on the underlying TJ pair don't pay us anything. Our pitch has to make wrapped LP strictly better (safety, automation, discovery, MCP) than direct LP. This is a product-marketing problem more than a technical one.
- **Liquidity fragmentation between wrapped and direct LP** — we're adding LP that lives "above" the pair via the wrapper. Wrapped LB shares and direct LB shares both consume the same bin reserves on the pair; no fragmentation at the swap-pricing level. Confirmed safe.
- **One-sided deposit share math.** When a user deposits only WETH (which mints into bins below active price) or only the project token (above active price), how is their "share of pool value" computed for receipt minting? Naively valuing the deposit at active-bin price under-weights the LP if their side later moves into the money. Two reasonable approaches: (a) value all assets at active price at deposit time (simple, slight unfairness either direction); (b) issue receipt tokens that are *bin-aware* and redeem the depositor's specific bin contribution back at exit. (b) is more correct but breaks the "pure ERC-20" composability story. Decide in the contract implementation plan.
- **Per-pool position-shape state vs derive-from-LB-shares.** Two impl choices for letting `deposit` know where to mint: store the active shape in contract storage (operator sets via `setPositionShape`), or compute by querying the wrapper's current LB shares per bin. The first is simpler and cheaper to call but adds a privileged setter; the second is more elegant and avoids drift between recorded and actual state. Decide in the contract implementation plan.

---

**Status note:** this design captures the *product* and the *contract-level architecture*. Implementation details for each sub-project (Solidity code structure, bot internals, UI framework, MCP wire format) belong in the per-sub-project implementation plans, not here.
