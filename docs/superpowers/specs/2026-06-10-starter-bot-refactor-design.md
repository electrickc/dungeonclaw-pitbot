# STARTER Bot Refactor — Design Doc

**Date:** 2026-06-10
**Status:** Draft — brainstorming output, awaiting user review before implementation planning
**Owner:** electric-kc
**Supersedes:** §8.1 of `2026-06-09-managed-dlmm-pools-design.md` for the V1 bot scope.

---

## 1. Motivation

The Managed DLMM Pools design (2026-06-09) was a multi-tenant vault wrapper + factory + receipt-token system. After 4 rounds of red-team it's audit-ready but not deployed — auditing the wrapper is the binding constraint ($50–100k, 3–4 weeks calendar). V1 drops the wrapper entirely and ships a simpler product:

**V1 product:** Dungeon Labs runs a per-pool managed bot service. Teams keep custody of their LP via a 1-of-2 Gnosis Safe (their wallet + our bot wallet, either can sign). The bot uses an atomic mint/burn helper contract — same MEV defense as PitBotHelper.sol, no vault.

This spec covers **the bot itself** — sub-project 2 of the V1 decomposition.

## 2. V1 product overview

### Architecture diagram

```
            ┌──────────────────────────────────────────────────────────┐
            │  Central plane (off-chain — Dungeon Labs infra)          │
            │  Postgres DB ◀───── Teller bot (in SecretVM)             │
            │  - subscriptions    - watches USDC payments              │
            │  - pool registry    - reads DLABS balances → tier        │
            │  - SecretVM ids     - holds deployer key                 │
            │  - bot wallets      - provisions per-pool SecretVMs      │
            └──────────────────────────┬───────────────────────────────┘
                                       │  control API
       ┌───────────────────────────────┼───────────────────────────────┐
       │  Per-pool SecretVM (one per active subscription)              │
       │  ┌──────────────────────────────────────────────────────────┐ │
       │  │  Bot process (this sub-project)                          │ │
       │  │  - generates EOA wallet (TEE-sealed)                     │ │
       │  │  - polls control plane for config + commands             │ │
       │  │  - signs Safe txs to mint/burn via helper                │ │
       │  └──────────────────────────────────────────────────────────┘ │
       └────────────────────────────────┬──────────────────────────────┘
                                        │
                                        ▼  Base mainnet
       ┌─────────────────────────────────────────────────────────────┐
       │  Per-team on-chain:                                         │
       │  - Gnosis Safe (1-of-2: team wallet + bot wallet)           │
       │  - Helper contract (atomic mint/burn) owned by Safe         │
       │  - LP shares held by Safe                                   │
       │                                                             │
       │  Canonical TJ LB v2.0 pair (untouched)                      │
       └─────────────────────────────────────────────────────────────┘
```

### Tiers

| Tier | DLABS held | USDC monthly | Strategies | Auto-rebalance |
|---|---|---|---|---|
| **OPEN** | 0 | Highest | Spot-Spread only | No |
| **BASIC** | 100M | Lower | Spot-Spread OR Wall | No |
| **ADVANCED** | 250M | Lowest | All shapes (Spot-Concentrated, Spot-Spread, Spot-Wide, Curve, Bid-Ask, Wall) | Yes (dynamic shape switching, smart triggers) |

Sub-project 2 (this spec) covers **OPEN and BASIC** strategies. ADVANCED's additional shapes + auto-rebalance are sub-project 3, layered on the same codebase.

## 3. Scope

### In scope (this spec)
- Single bot process per pool, inside one SecretVM
- Outbound-only HTTP communication with a central control plane (no inbound network surface)
- TEE-sealed bot wallet generated at first boot
- Gnosis Safe (1-of-2) signing via `safe.execTransaction`
- Atomic mint/burn via existing PitBotHelper-style helper contract
- Two strategy modules: `SpotSpreadStrategy` and `WallStrategy`, behind a common `Strategy` interface
- Drift-based rebalance trigger (same logic as current PitBot)
- Per-pool config loaded from control plane on every sync poll
- State machine: BOOT → PENDING_SAFE_SETUP → RECONCILE → OPERATIONAL → PAUSED → RETIRED
- Persistent state on disk inside SecretVM for reboot resilience
- Comprehensive tests including fork-based integration

### Explicitly out of scope
- **No vault wrapper** — teams retain LP custody via Safe
- **No on-chain billing** — handled off-chain by teller bot scanning USDC payments
- **No on-chain DLABS gating** — tier checks happen in teller bot before SecretVM provisioning
- **No inbound network surface on the bot** — all comms outbound to control plane
- **No ADVANCED strategies** (Concentrated, Wide, Curve, Bid-Ask) — sub-project 3
- **No smart-trigger / auto-rebalance** — sub-project 3
- **No dashboard UI** — sub-project 5
- **No teller bot or provisioning service** — sub-project 4

## 4. The two STARTER strategies

### `SpotSpreadStrategy` (OPEN + BASIC + ADVANCED default)

Uniform distribution across N bins centered on the active bin. Both X and Y populated when both assets are available; one-sided fallback when only one asset is on hand.

**Config knobs (per pool):**
- `binCount` — total bins in the spread (default 20)
- `binsAbove` — bins above active (default = binCount / 2)
- `binsBelow` — bins below active (default = binCount - binsAbove)

**One-sided fallback rule:** if the Safe's available X is less than 1% of total deposit value, treat as "Y-only" and mint all Y below active (buy-pressure side). Symmetrically for "X-only" → mint all X above active (sell-pressure side). The 1% threshold avoids re-mint thrashing from dust. This is the design spec's "honest CLMM-native behaviour: when/if price reverts, the one-sided position consumes back into balance."

### `WallStrategy` (BASIC + ADVANCED)

The existing PitBot defensive wall logic, preserved verbatim. Y-only bins below the active bin, configurable depth + skew.

**Config knobs (per pool):**
- `binCount` — number of wall bins (default 7)
- `offsetFromActive` — gap between active bin and shallowest wall bin (default 1)
- `skew` — `linear` or `exponential` (default `exponential`)

### Common `Strategy` interface

```typescript
export interface Strategy {
  readonly id: 'spot-spread' | 'wall'

  /** Given activeBin and current (xWei, yWei) on hand, return a mint plan. */
  plan(input: {
    activeBin: number
    xAvailable: bigint
    yAvailable: bigint
  }): MintPlan

  /** Should the bot rebalance right now? */
  decide(input: {
    activeBin: number
    currentCenter: number | null
    lastRebalanceTs: number
    nowTs: number
    anyBinFilled: boolean
  }): { action: 'hold' | 'place' | 'reposition' | 'withdraw_filled'; reason: string }
}

export interface MintPlan {
  binIds: number[]
  distributionX: bigint[]   // sums to 0 or 1e18
  distributionY: bigint[]   // sums to 0 or 1e18
  amountX: bigint
  amountY: bigint
}
```

The trigger logic (`decide`) is implemented as a shared module in v1 — drift-based re-center, common to both strategies. ADVANCED in sub-project 3 will swap in a market-aware trigger behind the same interface.

## 5. Bot internals

### File layout (TypeScript, Bun or Node runtime)

```
src/
├── index.ts              # main loop, signal handling, lifecycle
├── config.ts             # config schema + env-var loader
├── controlPlane.ts       # outbound HTTP to control plane (sync, handshake, events)
├── pool.ts               # provider, signer, pair + helper + safe wrappers
├── strategy/
│   ├── index.ts          # Strategy interface
│   ├── spot-spread.ts    # uniform-around-active impl
│   └── wall.ts           # one-sided defensive wall impl
├── trigger.ts            # drift-based re-center logic
├── safeSigner.ts         # Gnosis Safe signing + execTransaction submission
├── tx.ts                 # atomic mint/burn helper calls, called THROUGH Safe
├── state.ts              # in-memory + disk-persisted state machine
└── price.ts              # active-bin tracker (carried over from current PitBot)
```

### Module responsibilities

**`index.ts`** — boots, loads env, transitions through lifecycle states, runs the operational loop. Catches SIGTERM for graceful shutdown.

**`controlPlane.ts`** — owns the HTTP client. Exposes:
- `handshake(botAddress) → void`
- `sync() → SyncResponse` (called every `pollIntervalSeconds`)
- `emitEvent(event) → void` (fire-and-forget, queued on failure)
- All calls authenticated via HMAC using `CONTROL_PLANE_TOKEN`

**`pool.ts`** — wraps ethers provider + bot wallet + Safe + helper + pair addresses. Exposes typed methods like `getActiveBin()`, `getSafeBalances()`, `getOurBinShares()`.

**`safeSigner.ts`** — given a target contract call (to, data, value), produces a Safe transaction object, signs with bot's TEE-sealed key, and submits via `safe.execTransaction`. Handles nonce management and concurrent-tx detection.

**`tx.ts`** — high-level operations: `mint(plan)`, `burn(binIds, shares)`, `swap(direction, amount)`. Each builds a Safe tx envelope around a helper call and submits via `safeSigner`.

**`strategy/`** — pure functions, no I/O. Given snapshot + balances, return a `MintPlan`. Easy to unit test.

**`trigger.ts`** — pure function. Given state + snapshot, return an action enum.

**`state.ts`** — state machine logic + on-disk persistence to a fixed path inside the SecretVM (e.g. `/data/state.json`). Writes synchronously on every transition.

## 6. Communication model — outbound polling only

The bot **never accepts inbound traffic**. All communication is outbound to the control plane.

### Boot env vars

```
POOL_ID=pool-xyz                         # which pool this VM is for
CONTROL_PLANE_URL=https://api.dungeon.lab # our backend
CONTROL_PLANE_TOKEN=hmac-secret           # TEE-attested mutual auth
RPC_URL=https://lb.drpc.live/base/...     # Base RPC endpoint
```

### Handshake (on first boot)

```
POST /pools/{POOL_ID}/handshake
body: { botAddress: "0xABCD...", version: "1.0.0" }
response: 200 OK
```

Bot records its own wallet, control plane DB records `pool-xyz → bot 0xABCD`. Dashboard reads from DB and shows the user the bot address so they can add it to their Safe.

### Sync poll (every `pollIntervalSeconds`, default 30s)

```
GET /pools/{POOL_ID}/sync
response: {
  status: "pending_safe_setup" | "operational" | "paused" | "retired",
  safeAddress: "0xDEAD..." | null,
  helperAddress: "0xF00F..." | null,
  pairAddress: "0xA801F4..." | null,
  strategy: {
    type: "spot-spread" | "wall",
    knobs: { binCount: 20, binsAbove: 10, ... }
  },
  rebalanceCooldownSeconds: 60,
  syncPollIntervalSeconds: 30,    // how often the bot calls /sync
  chainPollIntervalSeconds: 15,   // how often the bot reads chain state for the operational loop
  killSwitch: false,
  consecutiveSyncFailureThreshold: 5  // after N failures, auto-pause
}
```

Bot reconciles: if status / safe / strategy changed, update in-memory state and act accordingly.

### Event emit (on every action)

```
POST /pools/{POOL_ID}/events
body: {
  ts: 1717920000,
  type: "rebalance" | "place" | "withdraw" | "error" | "state_transition",
  payload: { ...action-specific data }
}
```

Fire-and-forget. Failures are queued and retried; events don't block bot operation.

### Why polling instead of inbound API

- SecretVM is most easily operated without inbound port exposure
- No DNS or reverse proxy needed per pool
- Authentication is simpler (HMAC token rather than mutual TLS)
- ~30s update latency is acceptable because the bot's blast radius is limited (operator role only — can rebalance, not drain)
- Control plane is the single source of truth — bots converge to it

## 7. Safe interaction model

### Safe configuration

- Gnosis Safe with 2 owners (team's wallet + bot's wallet), threshold 1
- Bot deploys WITHOUT owning the Safe — team's wallet + bot's wallet are both added at Safe creation via the dashboard's setup wizard
- Helper contract is deployed with `owner = Safe address`
- LP shares (LB v2.0 ERC-1155) are held by the Safe

### Per-rebalance flow

1. Bot decides "place a new wall at bins [123, 124, 125, ...]" via `strategy.plan()`
2. Bot constructs the helper call: `helper.mintAtomic(ids, distX, distY, amountX, amountY)`
3. Bot wraps it in a Safe tx: `safe.execTransaction(helperAddress, 0, callData, ..., signatures)`
4. Bot signs the Safe tx hash with its TEE-sealed key — single signature, since threshold is 1
5. Bot submits via `safe.execTransaction(...)` from its own wallet (bot pays gas)
6. Safe forwards to helper, helper does `tokenY.transferFrom(Safe, pair, amountY)` + `pair.mint(...)` atomically
7. LB shares minted to Safe

### Gas funding

- Bot wallet pays Solidity gas for `execTransaction` submission
- Bot wallet is funded by the team via direct transfer (visible in dashboard with a "fund bot gas" CTA)
- Configurable low-balance threshold; webhook fires on low balance so dashboard can alert the team
- Bot does NOT attempt to pull gas from the Safe — gas is the operator's cost

### Team override

- Team can sign + execute Safe txs directly via the dashboard (or official Safe app)
- Bot detects via on-chain nonce changes; backs off if a team tx is pending or recent
- Team can rotate bot wallet via `safe.swapOwner(prevOwner, oldBot, newBot)` — bot detects (no longer in owners list) and transitions to PAUSED

## 8. State machine

```
        ┌─────────────┐
        │   BOOT      │
        └──────┬──────┘
               │ handshake succeeds
               ▼
        ┌─────────────┐
        │ PENDING_    │  Poll /sync; status == pending_safe_setup
        │ SAFE_SETUP  │  No on-chain action.
        └──────┬──────┘
               │ control plane returns safeAddress != null
               ▼
        ┌─────────────┐
        │   RECONCILE │  Validate Safe owns helper; bot is Safe owner;
        │             │  reconstruct any existing position from chain
        └──────┬──────┘
               │ invariants hold
               ▼
        ┌─────────────┐
        │ OPERATIONAL │  Run trigger → strategy → Safe-tx loop
        └─┬───────────┘
          │
          ├── status == paused      → PAUSED
          ├── status == retired     → RETIRED (graceful shutdown)
          ├── killSwitch == true    → PAUSED immediately
          └── N consecutive sync failures → PAUSED (control plane unreachable)

        ┌─────────────┐
        │   PAUSED    │  Keep polling. Resume on status == operational.
        └──────┬──────┘
               │ status == retired
               ▼
        ┌─────────────┐
        │   RETIRED   │  Exit container.
        └─────────────┘
```

### Failure handling

| State | Failure | Behavior |
|---|---|---|
| BOOT | Handshake fails | Exponential backoff, retry forever. Container stays up. |
| RECONCILE | Safe doesn't own helper | Transition to PAUSED with `reason: "invariants violated"`. Webhook fires. |
| RECONCILE | Bot wallet not in Safe owners | Same — PAUSED, alert operator. |
| OPERATIONAL | RPC failure | Retry with backoff. Don't transition state. |
| OPERATIONAL | Safe tx revert | Webhook fires with revert reason. Wait full cooldown before retrying. |
| OPERATIONAL | Bot gas wallet near empty | Webhook fires. Operations continue until balance is 0; then Safe txs revert. |
| OPERATIONAL | killSwitch true | PAUSED immediately, do not execute any pending tx. |
| Any | N consecutive sync failures | PAUSED automatically (can't trust desired state). Resume on first successful sync. |

## 9. Testing

### Unit tests
- Each strategy: given input snapshot, assert `MintPlan` matches expected layout
- Trigger logic: given state + snapshot, assert action enum
- State machine: given event sequence, assert transitions and side effects
- Config schema validation: malformed config rejected at load time

### Integration tests (fork-based)
- Fork Base at a recent block. Deploy Safe + helper + helper-owned-by-Safe setup.
- Boot bot against a mock control plane.
- Full lifecycle: BOOT → handshake → PENDING_SAFE_SETUP → safe set → RECONCILE → OPERATIONAL → execute rebalance → PAUSED → RETIRED.
- Run both strategies end-to-end. Assert correct bin shares end up in Safe.

### Network fault tests
- Mock control plane returns 5xx → assert backoff
- Mock control plane unreachable → assert auto-pause after N failures
- RPC returns reverts → assert no state corruption

### Adversarial tests
- Concurrent team Safe activity (simulate team signing competing tx) → bot detects nonce conflict, retries
- Bot wallet rotated out of Safe → bot detects, transitions to PAUSED with clear reason
- Safe drained externally (simulate team direct withdrawal) → bot's next mint fails gracefully

### Carryover from current PitBot
- The fork-based tests in `dungeonclaw-contracts/test/PitBotHelper.t.sol` for the helper contract pattern apply unchanged (helper is the existing contract pattern)

## 10. Reuse vs rewrite from current PitBot

### Reuse (mostly unchanged)
- `price.ts` — active-bin tracker
- `webhook.ts` — outbound event emit (rename to fit new control plane API)
- Pair ABI fragments from `abi.ts`
- Helper ABI from `abi.ts`
- The wall strategy math (extract from current `strategy.ts` into `strategy/wall.ts`)

### Rewrite
- `index.ts` — new main loop driven by state machine + control-plane sync
- `config.ts` — config now comes from control plane, not env vars (env vars only carry pool ID + endpoint)
- `pool.ts` — generalized; not hardcoded WETH/DCLAW; reads Safe address from sync response
- `tx.ts` — calls go THROUGH Safe via `execTransaction`, not directly to helper
- New file: `safeSigner.ts`
- New file: `controlPlane.ts`
- New file: `state.ts` (state machine)
- New file: `strategy/spot-spread.ts`

### Drop
- The single-tenant env-var-only config pattern
- The current admin webhook (Vercel-protected) — replaced by control-plane events

## 11. Risks & open questions

- **Single point of failure: control plane.** If down, all bots auto-pause after N polls. Mitigation: control plane HA, monitoring, graceful degradation. Decided OK for V1.
- **Bot wallet gas funding UX.** Teams need to remember to refill. Dashboard will surface this. Long-term option: bot accepts a small ETH transfer from Safe for its own gas, but that needs careful threshold logic.
- **Concurrent Safe activity.** If team signs a tx while bot is preparing one, nonce conflict. Bot detects via pre-tx nonce check and backs off; team's tx wins. Acceptable.
- **DLABS balance changes mid-subscription.** If a team holds 250M DLABS (ADVANCED), then drops to 50M, do we downgrade them mid-month? Teller bot's call — out of bot scope.
- **Hot-reload of strategy config.** Currently the bot updates strategy params on next sync. Long-term: do we ever need atomic "swap strategy type" without a full re-mint? Probably not for V1.

## 12. What this unblocks

V1 with this bot landed:
- DungeonClaw migrates DCLAW/WETH pool to: Safe + new helper (clone of PitBotHelper) + this bot
- Wall strategy preserved, same defensive behavior
- New teams can sign up for OPEN/BASIC tiers, use Spot-Spread default
- Teller bot (sub-project 4) handles billing + provisioning
- Dashboard (sub-project 5) handles team UX
- ADVANCED tier (sub-project 3) can layer on additional strategies + smart triggers later without redesigning the bot's core

## 13. Sub-project dependency order for V1

1. Helper contract (already deployed as `PitBotHelper.sol`; a tiny factory wrapper to deploy per team) — **sub-project 6**
2. **STARTER bot (this spec)** — **sub-project 2**
3. Teller bot (payment scanning, tier resolution, SecretVM provisioning) — **sub-project 4**
4. Dashboard UI (pool setup, Safe ops, bot control) — **sub-project 5**
5. Onboarding + migration of DCLAW pool — operational, not a code sub-project
6. ADVANCED bot (extra strategies + smart trigger) — **sub-project 3** (deferred)

Sub-project 2 (this one) can be built in parallel with sub-project 4 (teller). Sub-project 5 (dashboard) gates user-facing launch but can lag.

---

**Status note:** this spec covers the bot in detail. Implementation details (exact RPC interfaces, deployment scripts, container images) belong in the implementation plan.
