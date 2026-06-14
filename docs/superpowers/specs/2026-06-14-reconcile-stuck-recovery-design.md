# Reconcile-Stuck Recovery Design

**Date:** 2026-06-14
**Repo:** `dungeonclaw-pitbot` (TypeScript bot, ethers + viem)
**Affects:** `src/index.ts` (state machine + reconcile + operationalTick), `src/state.ts` (no schema changes)

## Problem

Operational incident: Pool 1's bot (`maroon-mandrill.vm.scrtlabs.com`) sat in `state=RECONCILE` for hours, polling every 30s and reporting `[sync] ok status=operational`, but never executing reconcile-internal log lines or transitioning out. The bot was healthy at the process / sync layer but completely stuck at the state-machine layer. Only a VM restart unstuck it.

Root cause analysis:

1. **`poll()`'s switch in `src/index.ts:90` has no `case 'RECONCILE':`**. When state=RECONCILE, the poll function returns immediately. The only way out of RECONCILE is for `reconcile()` itself to call `stateManager.transition()`. If `reconcile()` ever throws between transition-to-RECONCILE (line 128) and transition-to-OPERATIONAL (line 182) without going through the inner `try/catch` on `validateInvariants` (line 159), the state machine is stuck.
2. **Only the invariants check is wrapped in `try/catch`.** RPC calls in `pool.snapshot()` and `pool.safeBinPositions()` are not. An uncaught exception or a hung RPC silently leaves state at RECONCILE.
3. **No RPC-level timeouts.** ethers' default RPC client retries with backoff and can wait minutes on a wedged endpoint. A reconcile cycle that hits a stuck RPC never completes and never errors loudly.

## Non-goals

- Replacing the state machine. `BotStateManager` is fine; we're only adding one switch case and timestamp checks against existing `lastTransitionTs`.
- Adding RPC timeouts everywhere in the bot. Scope is `reconcile()` only. `operationalTick()` benefits from the same treatment but is a follow-up.
- Reorganizing reconcile internals. The current step ordering (tokens → invariants → snapshot → bin positions) stays.
- A circuit breaker on flaky RPCs. The bot already has a `consecutiveSyncFailureThreshold` for control-plane sync; an RPC-side equivalent is out of scope for this round.

## Design

Three interlocking fixes, defense-in-depth.

### 1. `withTimeout` helper

Add a small utility:

```ts
export class RPCTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`RPC timeout (${ms}ms) on ${label}`)
    this.name = 'RPCTimeoutError'
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RPCTimeoutError(label, ms)), ms)
  })
  try {
    return await Promise.race([p, timeoutP])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
```

Lives in a new file `src/util/withTimeout.ts`. Single-responsibility, easy to unit-test.

**Per-call timeout: 20 seconds.** Typical RPC on Base via dRPC is 1–2s; 20s gives a 10× margin while still surfacing real hangs in under a minute.

### 2. Wrap reconcile's RPC calls

Every `await` against an RPC client inside `reconcile()` gets wrapped:

- `tempPair.tokenX()` and `tempPair.tokenY()` (current line 142)
- `pool.validateInvariants()` (line 155)
- `pool.snapshot()` (line 174)
- `pool.safeBinPositions(...)` (line 176)

Each wrapped with a descriptive label for the error message (`'tokens'`, `'invariants'`, `'snapshot'`, `'binPositions'`).

### 3. Outer try/catch around reconcile

The entire body of `reconcile()` after `stateManager.transition('RECONCILE', ...)` goes inside one outer `try/catch`. On any thrown error (including `RPCTimeoutError`):

1. Transition to `PAUSED` with reason `reconcile error: <message>`.
2. Emit an `error` event to the control plane with `{ reason: 'reconcile error', error: String(e) }`.
3. Return cleanly.

The existing inner `try/catch` on `validateInvariants` is removed — the outer one subsumes it. We lose the slightly more specific reason text (`invariant violation: ...`), but the error message itself still tells you which check failed.

### 4. State-machine escape: `case 'RECONCILE':` in `poll()`

Add a `case 'RECONCILE':` in the switch in `poll()`:

```ts
case 'RECONCILE': {
  const elapsedSec = Math.floor(Date.now() / 1000) - stateManager.snapshot.lastTransitionTs
  if (elapsedSec > RECONCILE_TIMEOUT_SECONDS) {
    console.warn(`[reconcile] stuck for ${elapsedSec}s — forcing PAUSED`)
    stateManager.transition('PAUSED', { reason: `reconcile timeout (${elapsedSec}s)` })
    try {
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: 'error',
        payload: { reason: 'reconcile timeout', elapsedSec },
      })
    } catch (e) {
      console.error(`[reconcile] error event emit failed: ${e}`)
    }
  }
  // Otherwise reconcile is still in flight — fall through (do nothing).
  break
}
```

`RECONCILE_TIMEOUT_SECONDS = 90`. This is the safety net behind fix #2 + #3. If a non-RPC layer hangs (e.g. ethers' internal retry, a runaway promise), this still catches it.

`stateManager.snapshot.lastTransitionTs` is in unix seconds, already maintained by `BotStateManager.transition()`. **No state schema change.**

### 5. Reconcile success log

At the very end of a successful reconcile (after `stateManager.transition('OPERATIONAL', ...)`), log:

```ts
const tookMs = Date.now() - reconcileStartMs
console.log(`[reconcile] done in ${tookMs}ms`)
```

This lets us tune `RECONCILE_TIMEOUT_SECONDS` from real data over time. `reconcileStartMs` captured at the very top of the function.

## Interaction with existing PAUSED self-heal

`poll()` already has logic at line 113–121: when state=PAUSED and `sync.safeAddress && sync.helperAddress && ...`, it transitions PAUSED → PENDING_SAFE_SETUP and calls `reconcile()` again.

This means our fix has automatic recovery: a reconcile that errors transitions to PAUSED → next poll cycle triggers a fresh reconcile attempt → if the root cause was transient (RPC blip), the bot self-heals; if persistent, every retry will log clearly and the admin can intervene.

The `RECONCILE_TIMEOUT_SECONDS` (90s) is comfortably less than 3× `chainPollIntervalSeconds` (default 90s), so a single stuck reconcile triggers the timeout before the next poll would have done anything anyway. Operator sees the error event within ~90–120s of the hang starting, instead of forever.

## Error event payload

Two new payload shapes the control plane will see in the `events` table:

```json
{ "reason": "reconcile error",   "error": "RPC timeout (20000ms) on snapshot" }
{ "reason": "reconcile timeout", "elapsedSec": 91 }
```

Existing event consumers (the admin Bots tab, the manage-pool page) treat `type='error'` as a status-flip signal already; no consumer changes needed.

## Testing

- `tests/withTimeout.test.ts` — unit tests for the helper: resolves on success, rejects with `RPCTimeoutError` on timeout, clears the timer on success.
- `tests/reconcileErrorPath.test.ts` — integration test that mocks `pool.snapshot()` to throw, asserts state transitions to PAUSED and `cp.emitEvent` is called with the right shape.
- `tests/reconcileTimeoutEscape.test.ts` — mocks `BotStateManager.snapshot.lastTransitionTs` to look like reconcile started 100s ago, calls `poll()`, asserts state transitions to PAUSED and emits the timeout event.

No fork tests for this round — the failure modes are purely state-machine + RPC-mock, no on-chain interaction needed.

## Rollout

- Land in a single PR. Three small changes (withTimeout, reconcile rewrap, poll switch case) are tightly coupled by intent; splitting them invites a half-fixed window.
- Bump the bot's Docker image version (currently `v0.1.4` per the janus-app provision route's bundled docker-compose). Use `v0.1.11` (pitbot is at 0.1.10 per package.json; janus-app still references v0.1.4 — version gap exists).
- Update `janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` to reference the new image tag in the inlined YAML.
- Existing VMs need to be RESTARTed (admin UI) or have their containers pulled (deploy script tbd). On the next reconcile, the new error paths activate.

## Out of scope (explicit)

- Per-RPC timeouts in `operationalTick()`. Same pattern would apply but is a separate PR.
- Per-RPC timeouts in `safeSigner.ts` / `tx.ts`. Mint and burn transactions have their own waiting model (txhash → confirmation) — wrapping in `withTimeout` here would conflict with the existing confirmation loop.
- A retry-with-backoff layer for transient RPC errors. The current behavior (any error → PAUSED → self-heal retries on next poll) is good enough for v1.
- Circuit breaker on consecutive reconcile failures. If we see this happen in the wild we'll spec it as a separate fix.
