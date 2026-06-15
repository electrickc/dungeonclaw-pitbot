# Reconcile-Stuck Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the pitbot from getting permanently stuck in `state=RECONCILE` when an RPC call hangs or `reconcile()` throws between the entry-transition and exit-transition.

**Architecture:** Three defense-in-depth fixes shipped as one PR. (1) A small `withTimeout()` helper wraps every RPC call inside `reconcile()` with a 20s per-call timeout that surfaces as a thrown `RPCTimeoutError`. (2) An outer `try/catch` around the entire `reconcile()` body catches any throw and transitions to PAUSED + emits an `error` event to the control plane. (3) `poll()`'s switch gets a new `case 'RECONCILE':` that escapes to PAUSED after 90s in state using the already-tracked `lastTransitionTs`. The existing PAUSED self-heal path then retries reconcile on the next poll.

**Tech Stack:** TypeScript, ethers v6.13, vitest 4.x, Docker (image published to ghcr.io/electrickc/janus-starter-bot).

**Spec:** `docs/superpowers/specs/2026-06-14-reconcile-stuck-recovery-design.md`

---

## File Map

**Created:**

| File | Responsibility |
|---|---|
| `src/util/withTimeout.ts` | `withTimeout(promise, ms, label)` helper + `RPCTimeoutError` class |
| `test/withTimeout.test.ts` | Unit tests for the helper |
| `test/reconcileErrorPath.test.ts` | Integration test: a throwing RPC inside reconcile triggers PAUSED + error event |
| `test/reconcileTimeoutEscape.test.ts` | Integration test: poll() exits stuck RECONCILE after 90s |

**Modified:**

| File | Change |
|---|---|
| `src/index.ts` | Wrap 4 RPC calls in `withTimeout`, outer try/catch around `reconcile()`, add `case 'RECONCILE':` to `poll()` switch, add `[reconcile] done in Nms` log |
| `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` | Bump `image: ghcr.io/electrickc/janus-starter-bot:v0.1.4` → `:v0.1.11` in the inlined `DOCKER_COMPOSE_YAML` constant |

---

## Task 1: `withTimeout` helper

**Files:**
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/util/withTimeout.ts`
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/withTimeout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/withTimeout.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { withTimeout, RPCTimeoutError } from '../src/util/withTimeout'

describe('withTimeout', () => {
  it('resolves with the underlying value when the promise wins', async () => {
    const r = await withTimeout(Promise.resolve(42), 100, 'test')
    expect(r).toBe(42)
  })

  it('rejects with RPCTimeoutError when the timer wins', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50))
    await expect(withTimeout(slow, 10, 'slow-op')).rejects.toThrow(RPCTimeoutError)
  })

  it('error message includes the label and ms', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50))
    try {
      await withTimeout(slow, 10, 'snapshot')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(RPCTimeoutError)
      expect((e as Error).message).toContain('snapshot')
      expect((e as Error).message).toContain('10')
    }
  })

  it('clears the timer on success (no dangling handles)', async () => {
    const spy = vi.spyOn(global, 'clearTimeout')
    await withTimeout(Promise.resolve('ok'), 5000, 'fast')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('propagates a rejection from the underlying promise unchanged', async () => {
    const err = new Error('rpc revert')
    await expect(withTimeout(Promise.reject(err), 100, 'tokens')).rejects.toBe(err)
  })
})
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/withTimeout.test.ts
```

Expected: 5 failures, all "Cannot find module '../src/util/withTimeout'".

- [ ] **Step 3: Implement the helper**

Create `src/util/withTimeout.ts`:

```ts
export class RPCTimeoutError extends Error {
  constructor(public readonly label: string, public readonly ms: number) {
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

- [ ] **Step 4: Run, confirm pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/withTimeout.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/util/withTimeout.ts test/withTimeout.test.ts
git commit -m "util: withTimeout helper + RPCTimeoutError

Used by reconcile() to surface hung RPC calls as exceptions instead of
letting the bot sit forever in RECONCILE state."
```

---

## Task 2: Wrap reconcile's RPC calls + outer try/catch

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/index.ts` (the `reconcile()` function, currently spans roughly lines 126–184)

Current shape (paraphrased):

```ts
async function reconcile(sync: SyncResponse) {
  console.log('[reconcile] start')
  stateManager.transition('RECONCILE', { reason: 'safe + strategy configured' })

  if (!sync.safeAddress || ...) throw new Error(...)

  const wallet = ensureBotWallet()
  const tempProvider = new ethers.JsonRpcProvider(cfg.rpcUrl)
  const tempPair = new ethers.Contract(sync.pairAddress, [...], tempProvider)
  const [tokenX, tokenY] = await Promise.all([tempPair.tokenX(), tempPair.tokenY()])

  pool = new Pool(...)

  try {
    await pool.validateInvariants()
  } catch (e) {
    stateManager.transition('PAUSED', { reason: `invariant violation: ${e}` })
    await cp.emitEvent({ ts: ..., type: 'error', payload: { reason: 'invariant violation', error: String(e) } })
    return
  }

  signer = new SafeSigner(pool.safe, pool.wallet)
  tx = new TxLayer(pool, signer)
  strategy = buildStrategy(sync.strategy)

  const snap = await pool.snapshot()
  const positions = await pool.safeBinPositions(snap.activeBin, 50)
  const currentCenter = positions.length === 0 ? null : Math.round(...)
  stateManager.update({ currentCenter })

  stateManager.transition('OPERATIONAL', { reason: 'reconciled' })
  console.log('[reconcile] → OPERATIONAL')
}
```

Target shape: every RPC await wrapped, the inner invariants try/catch removed (subsumed by the outer one), and one outer try/catch around the whole body that emits a structured error event on any throw.

- [ ] **Step 1: Add import for withTimeout at the top of `src/index.ts`**

After the existing imports, add:

```ts
import { withTimeout } from './util/withTimeout'

const RPC_TIMEOUT_MS = 20_000
```

- [ ] **Step 2: Replace the body of `reconcile()` with the new version**

The replacement preserves every existing log line, removes the inner try/catch, wraps the 4 RPC calls, and adds the outer try/catch + duration log:

```ts
async function reconcile(sync: SyncResponse) {
  console.log('[reconcile] start')
  const startMs = Date.now()
  stateManager.transition('RECONCILE', { reason: 'safe + strategy configured' })

  if (!sync.safeAddress || !sync.helperAddress || !sync.pairAddress || !sync.strategy) {
    throw new Error('reconcile called with incomplete sync')
  }

  try {
    const wallet = ensureBotWallet()
    console.log(`[reconcile] reading tokens via RPC ${cfg.rpcUrl.slice(0, 40)}...`)
    const tempProvider = new ethers.JsonRpcProvider(cfg.rpcUrl)
    const tempPair = new ethers.Contract(
      sync.pairAddress,
      ['function tokenX() view returns (address)', 'function tokenY() view returns (address)'],
      tempProvider,
    )
    const [tokenX, tokenY] = await withTimeout(
      Promise.all([tempPair.tokenX(), tempPair.tokenY()]),
      RPC_TIMEOUT_MS,
      'tokens',
    )
    console.log(`[reconcile] tokenX=${tokenX} tokenY=${tokenY}`)

    pool = new Pool(cfg.rpcUrl, wallet.privateKey, {
      safe: sync.safeAddress,
      helper: sync.helperAddress,
      pair: sync.pairAddress,
      tokenX,
      tokenY,
    })

    console.log('[reconcile] validating invariants')
    await withTimeout(pool.validateInvariants(), RPC_TIMEOUT_MS, 'invariants')
    console.log('[reconcile] invariants OK')

    signer = new SafeSigner(pool.safe, pool.wallet)
    tx = new TxLayer(pool, signer)
    strategy = buildStrategy(sync.strategy)
    console.log(`[reconcile] strategy=${sync.strategy.type} signer/tx layers ready`)

    console.log('[reconcile] reading active bin snapshot')
    const snap = await withTimeout(pool.snapshot(), RPC_TIMEOUT_MS, 'snapshot')
    console.log(`[reconcile] activeBin=${snap.activeBin} — scanning ±50 bin positions`)
    const positions = await withTimeout(
      pool.safeBinPositions(snap.activeBin, 50),
      RPC_TIMEOUT_MS,
      'binPositions',
    )
    console.log(`[reconcile] ${positions.length} positions found`)
    const currentCenter =
      positions.length === 0 ? null : Math.round(positions.reduce((a, p) => a + p.id, 0) / positions.length)
    stateManager.update({ currentCenter })

    stateManager.transition('OPERATIONAL', { reason: 'reconciled' })
    console.log(`[reconcile] done in ${Date.now() - startMs}ms`)
    console.log('[reconcile] → OPERATIONAL')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[reconcile] error: ${msg}`)
    stateManager.transition('PAUSED', { reason: `reconcile error: ${msg}` })
    try {
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: 'error',
        payload: { reason: 'reconcile error', error: msg },
      })
    } catch (emitErr) {
      console.error(`[reconcile] error event emit failed: ${emitErr}`)
    }
  }
}
```

Use Edit to replace the existing `reconcile()` function body. Be careful to match the exact existing function start (`async function reconcile(sync: SyncResponse) {`) and end (the closing `}` immediately before `async function operationalTick`).

- [ ] **Step 3: Write the error-path integration test**

Create `test/reconcileErrorPath.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// We test reconcile by mocking the modules it depends on, then importing
// src/index.ts fresh per test. Because src/index.ts has top-level
// side-effects (loadConfig, statePath), we point STATE_PATH at a tmp dir.

describe('reconcile() error paths', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-err-'))
    process.env.STATE_PATH = path.join(tmpDir, 'state.json')
    process.env.POOL_ID = 'p-test'
    process.env.CONTROL_PLANE_URL = 'http://localhost/api/v1'
    process.env.CONTROL_PLANE_TOKEN = 'tkn'
    process.env.RPC_URL = 'http://localhost:8545'
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('throwing RPC inside reconcile → state=PAUSED + cp.emitEvent error called', async () => {
    const emitEvent = vi.fn(async () => undefined)

    vi.doMock('../src/controlPlane', () => ({
      ControlPlaneClient: class {
        constructor() {}
        async handshake() {}
        async sync() {
          return {
            status: 'operational', killSwitch: false,
            safeAddress: '0x' + '11'.repeat(20),
            helperAddress: '0x' + '22'.repeat(20),
            pairAddress: '0x' + '33'.repeat(20),
            strategy: { type: 'spot-spread', knobs: {} },
            rebalanceCooldownSeconds: 900,
            syncPollIntervalSeconds: 30,
            chainPollIntervalSeconds: 30,
            consecutiveSyncFailureThreshold: 3,
          }
        }
        emitEvent = emitEvent
      },
    }))

    // Make pool.validateInvariants throw — the failure should be caught by
    // the new outer try/catch.
    vi.doMock('../src/pool', () => ({
      Pool: class {
        async validateInvariants() { throw new Error('boom') }
        async snapshot() { return { activeBin: 8388608, binStep: 10, safeXBalance: 0n, safeYBalance: 0n } }
        async safeBinPositions() { return [] }
      },
    }))

    // tx + safeSigner are constructed but not called in this test path.
    vi.doMock('../src/safeSigner', () => ({ SafeSigner: class { constructor() {} } }))
    vi.doMock('../src/tx', () => ({ TxLayer: class { constructor() {} } }))
    vi.doMock('../src/strategy', () => ({
      buildStrategy: () => ({ id: 'spot-spread', plan: () => null as never }),
    }))

    // ethers Contract reads need to succeed for tokens.
    vi.doMock('ethers', async () => {
      const actual = await vi.importActual<typeof import('ethers')>('ethers')
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          JsonRpcProvider: class { constructor() {} },
          Contract: class {
            async tokenX() { return '0x' + '44'.repeat(20) }
            async tokenY() { return '0x' + '55'.repeat(20) }
          },
          Wallet: class {
            address = '0x' + '66'.repeat(20)
            privateKey = '0x' + '77'.repeat(32)
            static createRandom() { return new (this as never)() }
          },
        },
      }
    })

    const indexMod = await import('../src/index')
    const reconcile = (indexMod as unknown as { reconcile: (sync: unknown) => Promise<void> }).reconcile

    // If src/index.ts doesn't export reconcile, this test file needs the
    // module to export it. Step 4 below makes that change.
    expect(typeof reconcile).toBe('function')

    await reconcile({
      status: 'operational', killSwitch: false,
      safeAddress: '0x' + '11'.repeat(20),
      helperAddress: '0x' + '22'.repeat(20),
      pairAddress: '0x' + '33'.repeat(20),
      strategy: { type: 'spot-spread', knobs: {} },
      rebalanceCooldownSeconds: 900,
      syncPollIntervalSeconds: 30,
      chainPollIntervalSeconds: 30,
      consecutiveSyncFailureThreshold: 3,
    })

    const stateOnDisk = JSON.parse(fs.readFileSync(process.env.STATE_PATH!, 'utf8'))
    expect(stateOnDisk.current).toBe('PAUSED')
    expect(stateOnDisk.reason).toMatch(/reconcile error/)
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      payload: expect.objectContaining({ reason: 'reconcile error' }),
    }))
  })
})
```

- [ ] **Step 4: Export `reconcile` from `src/index.ts` so the test can call it**

In `src/index.ts`, change the function declaration from:

```ts
async function reconcile(sync: SyncResponse) {
```

to:

```ts
export async function reconcile(sync: SyncResponse) {
```

If src/index.ts wasn't exporting anything before, this is the first export and is fine — TypeScript treats a module with any export the same as before for the rest of the code (the bot's main loop still runs on import side-effects).

- [ ] **Step 5: Run the error-path test, confirm pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/reconcileErrorPath.test.ts
```

Expected: 1 pass. If it fails because the test setup can't construct the bot's module-level state, the test mocks may need tightening — but the assertion about state transition + emitEvent should hold once the import succeeds.

- [ ] **Step 6: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/index.ts test/reconcileErrorPath.test.ts
git commit -m "reconcile: wrap RPC calls in withTimeout + outer try/catch

Every RPC inside reconcile() now has a 20s per-call timeout. An outer
try/catch converts any throw into a clean PAUSED transition + error
event, so the bot can never silently get stuck mid-reconcile again.

The inner try/catch around validateInvariants is removed; the outer one
subsumes it. Error message preserves the failing operation's label."
```

---

## Task 3: `case 'RECONCILE':` escape in `poll()`

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/index.ts` (the `poll()` switch, currently lines ~90–123)
- Create: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/reconcileTimeoutEscape.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/reconcileTimeoutEscape.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe("poll() case 'RECONCILE' escape", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-escape-'))
    process.env.STATE_PATH = path.join(tmpDir, 'state.json')
    process.env.POOL_ID = 'p-test'
    process.env.CONTROL_PLANE_URL = 'http://localhost/api/v1'
    process.env.CONTROL_PLANE_TOKEN = 'tkn'
    process.env.RPC_URL = 'http://localhost:8545'
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('escapes RECONCILE → PAUSED after >90s and emits timeout error event', async () => {
    const emitEvent = vi.fn(async () => undefined)

    vi.doMock('../src/controlPlane', () => ({
      ControlPlaneClient: class {
        async handshake() {}
        async sync() {
          return {
            status: 'operational', killSwitch: false,
            safeAddress: '0x' + '11'.repeat(20),
            helperAddress: '0x' + '22'.repeat(20),
            pairAddress: '0x' + '33'.repeat(20),
            strategy: { type: 'spot-spread', knobs: {} },
            rebalanceCooldownSeconds: 900,
            syncPollIntervalSeconds: 30,
            chainPollIntervalSeconds: 30,
            consecutiveSyncFailureThreshold: 3,
          }
        }
        emitEvent = emitEvent
      },
    }))

    // Seed state.json directly with state=RECONCILE and lastTransitionTs
    // set 100s in the past, so the escape branch fires.
    const oldTs = Math.floor(Date.now() / 1000) - 100
    fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify({
      current: 'RECONCILE',
      lastTransitionTs: oldTs,
      reason: 'stale',
      lastRebalanceTs: 0,
      currentCenter: null,
    }))

    const indexMod = await import('../src/index')
    const poll = (indexMod as unknown as { poll: () => Promise<void> }).poll
    expect(typeof poll).toBe('function')

    await poll()

    const stateOnDisk = JSON.parse(fs.readFileSync(process.env.STATE_PATH!, 'utf8'))
    expect(stateOnDisk.current).toBe('PAUSED')
    expect(stateOnDisk.reason).toMatch(/reconcile timeout/)
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      payload: expect.objectContaining({ reason: 'reconcile timeout' }),
    }))
  })

  it('does NOT escape RECONCILE if elapsed < 90s', async () => {
    const emitEvent = vi.fn(async () => undefined)
    vi.doMock('../src/controlPlane', () => ({
      ControlPlaneClient: class {
        async handshake() {}
        async sync() {
          return {
            status: 'operational', killSwitch: false,
            safeAddress: '0x' + '11'.repeat(20),
            helperAddress: '0x' + '22'.repeat(20),
            pairAddress: '0x' + '33'.repeat(20),
            strategy: { type: 'spot-spread', knobs: {} },
            rebalanceCooldownSeconds: 900,
            syncPollIntervalSeconds: 30,
            chainPollIntervalSeconds: 30,
            consecutiveSyncFailureThreshold: 3,
          }
        }
        emitEvent = emitEvent
      },
    }))

    const recentTs = Math.floor(Date.now() / 1000) - 10
    fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify({
      current: 'RECONCILE',
      lastTransitionTs: recentTs,
      reason: 'fresh',
      lastRebalanceTs: 0,
      currentCenter: null,
    }))

    const indexMod = await import('../src/index')
    const poll = (indexMod as unknown as { poll: () => Promise<void> }).poll

    await poll()

    const stateOnDisk = JSON.parse(fs.readFileSync(process.env.STATE_PATH!, 'utf8'))
    expect(stateOnDisk.current).toBe('RECONCILE')
    expect(emitEvent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/reconcileTimeoutEscape.test.ts
```

Expected: tests either fail because `poll` isn't exported, or pass-then-fail because the `case 'RECONCILE':` doesn't exist yet. Either way, RED.

- [ ] **Step 3: Add the constant + switch case**

Near the top of `src/index.ts`, alongside `RPC_TIMEOUT_MS`, add:

```ts
const RECONCILE_TIMEOUT_SECONDS = 90
```

Then in `poll()`'s switch (currently `case 'PENDING_SAFE_SETUP':`, `case 'OPERATIONAL':`, `case 'PAUSED':`), add **before** the closing `}` of the switch:

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
      console.error(`[reconcile] timeout error event emit failed: ${e}`)
    }
  }
  break
}
```

- [ ] **Step 4: Export `poll` from `src/index.ts`**

In `src/index.ts`, change:

```ts
async function poll() {
```

to:

```ts
export async function poll() {
```

- [ ] **Step 5: Run the test, confirm pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/reconcileTimeoutEscape.test.ts
```

Expected: 2 pass.

- [ ] **Step 6: Run the full unit test suite to confirm nothing else broke**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npm test
```

Expected: every existing test still passes plus the new `withTimeout` (5), `reconcileErrorPath` (1), `reconcileTimeoutEscape` (2) tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/index.ts test/reconcileTimeoutEscape.test.ts
git commit -m "poll: add case 'RECONCILE' that escapes to PAUSED after 90s

Safety net behind the per-RPC withTimeout. If reconcile() hangs at a
non-RPC layer (ethers internal retry, a runaway promise), poll() now
detects we've been in RECONCILE for >90s using stateManager's existing
lastTransitionTs, forces PAUSED, and emits an error event so the admin
UI shows the timeout.

The existing PAUSED self-heal path re-enters reconcile on the next poll
cycle, so transient failures self-recover."
```

---

## Task 4: Bump bot Docker image tag + janus-app provision YAML

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/Dockerfile` (no source change needed; the tag is applied at build/publish time)
- Modify: `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts`

The bot image at `ghcr.io/electrickc/janus-starter-bot` is published from this repo. The janus-app provision route inlines the version explicitly, so future-provisioned bots pick up the new image.

- [ ] **Step 1: Build + push the new image tag**

From `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot`:

```bash
docker build -t ghcr.io/electrickc/janus-starter-bot:v0.1.11 .
docker push ghcr.io/electrickc/janus-starter-bot:v0.1.11
```

Confirm with:

```bash
docker manifest inspect ghcr.io/electrickc/janus-starter-bot:v0.1.11 | head -20
```

Expected: a manifest object, not "no such manifest". If your repo uses GitHub Actions for image publishing instead of local docker push, push a git tag matching `v0.1.11` and let the workflow run.

- [ ] **Step 2: Update the janus-app provision route**

Edit `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` and change the inlined image line in the `DOCKER_COMPOSE_YAML` constant:

```ts
// Before:
//      image: ghcr.io/electrickc/janus-starter-bot:v0.1.4
// After:
      image: ghcr.io/electrickc/janus-starter-bot:v0.1.11
```

- [ ] **Step 3: Commit the janus-app change**

```bash
cd /Users/electrickc/DUNGEONLABS/janus-app
git add src/app/api/v1/admin/pools/[id]/provision/route.ts
git commit -m "provision: bump janus-starter-bot to v0.1.11

v0.1.11 adds the reconcile-stuck escape (withTimeout + RECONCILE case in
poll), so newly-provisioned VMs ship with the fix."
```

- [ ] **Step 4: Deploy janus-app**

```bash
cd /Users/electrickc/DUNGEONLABS/janus-app && npm run deploy:prod
```

Expected: deploy succeeds, custom domain alias re-points (per the deploy script).

---

## Task 5: Apply the fix to existing VMs

The two currently-provisioned VMs (`maroon-mandrill.vm.scrtlabs.com`, `salmon-guppy.vm.scrtlabs.com`) are still running the old image. They need to pull v0.1.11.

There are two paths depending on how SecretVM handles container image updates:

**Option A — re-provision (clean but loses bot state file):**
STOP each pool via `/admin/bots`, then run the provision flow again. Loses the on-disk bot state and wallet — only acceptable if the bots were freshly stopped anyway.

**Option B — VM-side image pull (preserves state file):**
SSH into the SecretVM (if available), run `docker compose pull && docker compose up -d` in the bot's working dir. Preserves the wallet.key and state.json files.

- [ ] **Step 1: Pick an option and apply to one VM first**

Recommendation: Option B for `maroon-mandrill` (Pool 1, the stuck one) so we test the fix end-to-end on the bot that needed it.

- [ ] **Step 2: Watch the logs after the new container boots**

Expected sequence (per the spec):
```
[boot] pool=ad9da541-... state=...
[boot] handshake sent
[poll] state=PENDING_SAFE_SETUP
[reconcile] start
[reconcile] reading tokens via RPC ...
[reconcile] tokenX=... tokenY=...
[reconcile] validating invariants
[reconcile] invariants OK
[reconcile] strategy=spot-spread signer/tx layers ready
[reconcile] reading active bin snapshot
[reconcile] activeBin=... — scanning ±50 bin positions
[reconcile] 0 positions found
[reconcile] done in <N>ms
[reconcile] → OPERATIONAL
[tick] active=... action=place reason=no position present
```

The key line that confirms the new build: `[reconcile] done in <N>ms`. The previous build didn't have that log.

- [ ] **Step 3: Apply to the second VM after confirming pool 1 works**

Repeat for `salmon-guppy` (Pool 2, currently working — the upgrade is to keep both VMs on the same code path).

- [ ] **Step 4: Spot-check admin UI**

Open `/admin/bots`. Both rows should show OPERATIONAL (or STALE briefly until a place/rebalance event lands), TVL non-zero, PnL near zero (fresh baseline from earlier today).

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
|---|---|
| `withTimeout` helper + `RPCTimeoutError` | Task 1 |
| Per-call timeouts on 4 RPC sites in reconcile | Task 2 step 2 |
| Outer try/catch around reconcile | Task 2 step 2 |
| Removal of inner invariants try/catch (subsumed) | Task 2 step 2 |
| `case 'RECONCILE':` in poll() switch | Task 3 |
| 90-second `RECONCILE_TIMEOUT_SECONDS` | Task 3 step 3 |
| Error event emit on reconcile error | Task 2 step 2 |
| Error event emit on timeout escape | Task 3 step 3 |
| `[reconcile] done in Nms` observability log | Task 2 step 2 |
| Bump bot image to v0.1.11 | Task 4 |
| Update janus-app provision YAML | Task 4 step 2 |
| `withTimeout` unit tests | Task 1 step 1 |
| Reconcile error-path integration test | Task 2 step 3 |
| Reconcile timeout-escape integration test | Task 3 step 1 |
| No state schema change | Verified — uses existing `lastTransitionTs` |

No gaps.

**Placeholder scan:** clean. Explicit values everywhere (20_000ms, 90s, v0.1.11, exact log strings).

**Type consistency:**
- `RPCTimeoutError` defined in Task 1, imported via the umbrella `withTimeout` import in Task 2 — re-exported by the same module.
- `RPC_TIMEOUT_MS = 20_000` defined in Task 2, used in Task 2 only.
- `RECONCILE_TIMEOUT_SECONDS = 90` defined in Task 3, used in Task 3 only.
- `cp.emitEvent` shape `{ ts, type, payload }` is the existing ControlPlaneClient API (used throughout `src/index.ts` already).
- `stateManager.snapshot.lastTransitionTs` is an existing field on `BotState` — Task 3 reads it; nothing creates a new field.
- Test imports use `'../src/index'` and `'../src/util/withTimeout'` consistently.

All consistent.
