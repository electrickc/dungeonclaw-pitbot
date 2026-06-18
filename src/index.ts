import { ethers } from 'ethers'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config'
import { ControlPlaneClient, SyncResponse } from './controlPlane'
import { BotStateManager } from './state'
import { Pool } from './pool'
import { SafeSigner } from './safeSigner'
import { TxLayer } from './tx'
import { buildStrategy, Strategy } from './strategy'
import { decide } from './trigger'
import { withTimeout } from './util/withTimeout'

const RPC_TIMEOUT_MS = 20_000
const RECONCILE_TIMEOUT_SECONDS = 90

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

// Bot key — generated once on first boot, persisted next to state.json on the
// SecretVM's encrypted volume so container restarts keep the same identity.
// File mode is 0600 (owner read/write only). Sealed by the SecretVM TEE.
let botWallet: ethers.Wallet | null = null

function ensureBotWallet(): ethers.Wallet {
  if (botWallet) return botWallet
  const walletPath = path.join(path.dirname(cfg.statePath), 'wallet.key')
  if (fs.existsSync(walletPath)) {
    const pk = fs.readFileSync(walletPath, 'utf8').trim()
    botWallet = new ethers.Wallet(pk)
  } else {
    const fresh = ethers.Wallet.createRandom()
    // mode 0o700 on the parent so non-owner uids can't list / chmod-bypass
    // the 0o600 wallet file itself. Defense-in-depth on the SecretVM TEE.
    fs.mkdirSync(path.dirname(walletPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(walletPath, fresh.privateKey, { mode: 0o600 })
    botWallet = new ethers.Wallet(fresh.privateKey)
  }
  return botWallet
}

async function boot() {
  console.log(`[boot] pool=${cfg.poolId} state=${stateManager.current}`)
  const wallet = ensureBotWallet()
  await cp.handshake(wallet.address)
  console.log(`[boot] handshake sent, address=${wallet.address}`)
  // First-boot path: BOOT → PENDING_SAFE_SETUP. On restart, the persisted
  // state may be PAUSED/OPERATIONAL/etc; transition to PENDING_SAFE_SETUP
  // to re-enter the setup→reconcile flow with the (now-persistent) wallet.
  if (stateManager.current !== 'PENDING_SAFE_SETUP' && stateManager.current !== 'RETIRED') {
    stateManager.transition('PENDING_SAFE_SETUP', { reason: 'boot' })
  }
}

export async function poll() {
  console.log(`[poll] state=${stateManager.current}`)
  let sync: SyncResponse
  try {
    sync = await cp.sync()
    consecutiveSyncFailures = 0
    lastSync = sync
    console.log(`[sync] ok status=${sync.status} hasSafe=${!!sync.safeAddress} hasHelper=${!!sync.helperAddress} strategy=${sync.strategy?.type}`)
  } catch (e) {
    consecutiveSyncFailures += 1
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error(`[sync] failure ${consecutiveSyncFailures}: ${errMsg}`)
    if (lastSync && consecutiveSyncFailures >= lastSync.consecutiveSyncFailureThreshold) {
      if (stateManager.current === 'OPERATIONAL') {
        // Carry the underlying error + failure count + threshold into the
        // reason so operators can diagnose without grepping logs.
        stateManager.transition('PAUSED', {
          reason: `control plane unreachable: ${errMsg} (${consecutiveSyncFailures}/${lastSync.consecutiveSyncFailureThreshold})`,
        })
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
    case 'PAUSED':
      if (sync.status === 'operational' && !sync.killSwitch) {
        stateManager.transition('OPERATIONAL', { reason: 'resumed' })
        break
      }
      // Don't fight the operator: if the control plane explicitly says
      // "paused", skip self-heal entirely — the operator chose to stop us.
      if (sync.status === 'paused' || sync.killSwitch) break
      // Self-heal whitelist: only retry reconcile when the pause is a known
      // recoverable transient ("bot not yet a Safe owner" — the wizard races
      // bot provision and addOwner). For terminal reasons (bot_eth_low, etc.)
      // the loop would just hammer the same failing RPC every poll and spam
      // error events. Plus a 60s back-off so we don't burn quota.
      const reason = stateManager.snapshot.reason.toLowerCase()
      const SELF_HEAL_REASONS = ['not a safe owner', 'bot not yet', 'reconcile error', 'retry from paused']
      const isSelfHealable = SELF_HEAL_REASONS.some((r) => reason.includes(r))
      const SELF_HEAL_BACKOFF_S = 60
      const sinceLastAttempt = (Date.now() / 1000) - stateManager.snapshot.lastTransitionTs
      if (isSelfHealable && sinceLastAttempt >= SELF_HEAL_BACKOFF_S &&
          sync.safeAddress && sync.helperAddress && sync.pairAddress && sync.strategy) {
        console.log('[paused] attempting recovery via reconcile')
        try {
          stateManager.transition('PENDING_SAFE_SETUP', { reason: 'retry from paused' })
          await reconcile(sync)
        } catch (e) {
          console.error(`[paused] recovery attempt failed: ${e}`)
        }
      }
      break
  }
}

export async function reconcile(sync: SyncResponse) {
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

    // chainId assertion. Pool.provider uses `staticNetwork: true` to skip
    // per-call chainId checks. If RPC_URL was misconfigured to a different
    // chain at restart, the Safe's on-chain `block.chainid` would reject the
    // sig with `GS026`/`GS013` — failure surfaces opaquely. Fail loud here.
    const EXPECTED_CHAIN_ID = 8453n  // Base mainnet
    const network = await withTimeout(tempProvider.getNetwork(), RPC_TIMEOUT_MS, 'getNetwork')
    if (network.chainId !== EXPECTED_CHAIN_ID) {
      throw new Error(`unexpected chainId ${network.chainId} (expected ${EXPECTED_CHAIN_ID} Base mainnet) — check RPC_URL`)
    }

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
    // Share-weighted center: a one-sided wall/bid-ask strategy distributes
    // shares asymmetrically, so an unweighted arithmetic mean of bin IDs lands
    // off the true mint center, which makes the very next operationalTick
    // see a fake drift > threshold and burn the freshly-minted position.
    // Falls back to arithmetic if every position's share is zero (defensive).
    let currentCenter: number | null = null
    if (positions.length > 0) {
      const totalShares = positions.reduce((a, p) => a + (p.shares ?? 0n), 0n)
      if (totalShares > 0n) {
        // Math.round on a Number that came from a bigint division — bin IDs
        // fit in uint24, totals do too for reasonable mint sizes.
        const weightedNumerator = positions.reduce((a, p) => a + Number(p.shares ?? 0n) * p.id, 0)
        currentCenter = Math.round(weightedNumerator / Number(totalShares))
      } else {
        currentCenter = Math.round(positions.reduce((a, p) => a + p.id, 0) / positions.length)
      }
    }
    // Bot ETH balance gate — without ETH the bot cannot pay gas on
    // execTransaction and every tick reverts opaquely. Catch it loud at
    // reconcile so the control plane shows a structured 'paused: bot eth low'
    // instead of a stream of generic reverts the operator can't act on.
    const MIN_BOT_ETH_WEI = 500_000_000_000_000n  // 0.0005 ETH
    try {
      const balance = await pool.provider.getBalance(pool.wallet.address)
      console.log(`[reconcile] bot signer balance: ${balance.toString()} wei (${pool.wallet.address})`)
      if (balance < MIN_BOT_ETH_WEI) {
        stateManager.transition('PAUSED', {
          reason: `bot eth low: have ${balance.toString()} wei, need ${MIN_BOT_ETH_WEI.toString()}`,
        })
        try {
          await cp.emitEvent({
            ts: Math.floor(Date.now() / 1000),
            type: 'error',
            payload: { reason: 'bot_eth_low', balanceWei: balance.toString(), botAddress: pool.wallet.address },
          })
        } catch { /* best effort */ }
        return
      }
    } catch (e) {
      console.warn(`[reconcile] bot balance check failed: ${e}`)
    }
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

async function operationalTick(sync: SyncResponse) {
  if (!pool || !tx || !strategy) {
    // Spell out which dependency is null so the operator doesn't have to guess.
    const missing = [
      pool ? null : 'pool',
      tx ? null : 'tx',
      strategy ? null : 'strategy',
    ].filter(Boolean).join(',')
    stateManager.transition('PAUSED', {
      reason: `operational without ${missing} — module not reloaded after restart?`,
    })
    return
  }

  if (sync.strategy && sync.strategy.type !== strategy.id) {
    // Strategy shape change. The previous positions are sized for the OLD
    // shape; the next mint will use the NEW shape's bin distribution, which
    // can overlap or conflict with the leftover bins. PAUSE so the operator
    // can decide whether to manually burn-and-redeploy.
    const oldId = strategy.id
    console.log(`[op] strategy change detected: ${oldId} → ${sync.strategy.type}`)
    strategy = buildStrategy(sync.strategy)
    stateManager.transition('PAUSED', {
      reason: `strategy change ${oldId} → ${sync.strategy.type}: burn old position via control plane, then resume`,
    })
    try {
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: 'error',
        payload: { reason: 'strategy_change_requires_manual_migration', from: oldId, to: sync.strategy.type },
      })
    } catch { /* best effort */ }
    return
  }

  const snap = await pool.snapshot()
  const positions = await pool.safeBinPositions(snap.activeBin, 50)
  // FIXED: "fill" means swaps actually consumed our liquidity, NOT just "bin
  // sits below active" (that was always true for Wall by design, hot-looping
  // place→withdraw every tick). For Y-side positions (below active at mint),
  // a fill shows up as reserveX > 0 in the bin — swaps pushed price through,
  // converted Y to X. For X-side positions (above active) it's the inverse.
  // Single universal heuristic: a bin shows fill if it holds BOTH tokens or
  // the "wrong" token relative to its side.
  const anyBinFilled = positions.some((p) => {
    if (p.id === snap.activeBin) return false           // active bin always mixed
    return p.id < snap.activeBin
      ? p.reserveX > 0n   // Y-side bin filled = X appeared
      : p.reserveY > 0n   // X-side bin filled = Y appeared
  })

  const action = decide({
    activeBin: snap.activeBin,
    currentCenter: stateManager.snapshot.currentCenter,
    lastRebalanceTs: stateManager.snapshot.lastRebalanceTs,
    lastRebalanceCenter: stateManager.snapshot.lastRebalanceCenter ?? null,
    nowTs: Math.floor(Date.now() / 1000),
    anyBinFilled,
    rebalanceCooldownSeconds: sync.rebalanceCooldownSeconds,
    rebalanceBinsThreshold: sync.strategy?.knobs.rebalanceBinsThreshold ?? 2,
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
        binStep: updatedSnap.binStep,
      })
      const receipt = await tx.mint(plan)
      const newCenter = Math.round(plan.binIds.reduce((a, b) => a + b, 0) / plan.binIds.length)
      stateManager.update({
        currentCenter: newCenter,
        lastRebalanceCenter: newCenter,
        lastRebalanceTs: Math.floor(Date.now() / 1000),
      })
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

async function main() {
  process.on('SIGTERM', () => {
    console.log('[shutdown] SIGTERM received')
    process.exit(0)
  })

  await boot()
  try {
    await poll()
  } catch (e) {
    console.error(`[poll] first poll uncaught: ${e}`)
    if (e instanceof Error && e.stack) console.error(e.stack)
  }

  // setTimeout-recursion instead of setInterval. With setInterval, a poll
  // that takes longer than the configured interval (typical when waiting on
  // a Safe execTransaction receipt — up to 2 min — vs a 30s poll interval)
  // would fire a concurrent next tick. Two ticks reading/writing the same
  // state, both calling stateManager.transition(), both submitting txs from
  // the same nonce → races up to and including double-mint. This pattern
  // guarantees serial execution.
  const pollIntervalMs = (lastSync?.syncPollIntervalSeconds ?? 30) * 1000
  const schedule = (): void => {
    setTimeout(async () => {
      try {
        await poll()
      } catch (e) {
        console.error(`[poll] uncaught: ${e}`)
        if (e instanceof Error && e.stack) console.error(e.stack)
      } finally {
        schedule()
      }
    }, pollIntervalMs)
  }
  schedule()
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
