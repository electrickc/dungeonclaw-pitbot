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
    fs.mkdirSync(path.dirname(walletPath), { recursive: true })
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

async function poll() {
  console.log(`[poll] state=${stateManager.current}`)
  let sync: SyncResponse
  try {
    sync = await cp.sync()
    consecutiveSyncFailures = 0
    lastSync = sync
    console.log(`[sync] ok status=${sync.status} hasSafe=${!!sync.safeAddress} hasHelper=${!!sync.helperAddress} strategy=${sync.strategy?.type}`)
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
        break
      }
      // Self-heal: the most common reason for PAUSED is "bot not yet a Safe
      // owner" — the wizard always adds the bot AFTER provision, so the bot's
      // first reconcile races the user's addOwner signature. Retry reconcile
      // on every poll; once the user signs addOwner, the next attempt will
      // pass validateInvariants and we'll go OPERATIONAL.
      if (sync.safeAddress && sync.helperAddress && sync.pairAddress && sync.strategy) {
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

async function reconcile(sync: SyncResponse) {
  console.log('[reconcile] start')
  stateManager.transition('RECONCILE', { reason: 'safe + strategy configured' })

  if (!sync.safeAddress || !sync.helperAddress || !sync.pairAddress || !sync.strategy) {
    throw new Error('reconcile called with incomplete sync')
  }

  const wallet = ensureBotWallet()
  console.log(`[reconcile] reading tokens via RPC ${cfg.rpcUrl.slice(0, 40)}...`)
  const tempProvider = new ethers.JsonRpcProvider(cfg.rpcUrl)
  const tempPair = new ethers.Contract(
    sync.pairAddress,
    ['function tokenX() view returns (address)', 'function tokenY() view returns (address)'],
    tempProvider,
  )
  const [tokenX, tokenY] = await Promise.all([tempPair.tokenX(), tempPair.tokenY()])
  console.log(`[reconcile] tokenX=${tokenX} tokenY=${tokenY}`)

  pool = new Pool(cfg.rpcUrl, wallet.privateKey, {
    safe: sync.safeAddress,
    helper: sync.helperAddress,
    pair: sync.pairAddress,
    tokenX,
    tokenY,
  })

  try {
    console.log('[reconcile] validating invariants')
    await pool.validateInvariants()
    console.log('[reconcile] invariants OK')
  } catch (e) {
    console.error(`[reconcile] invariant violation: ${e}`)
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
  console.log(`[reconcile] strategy=${sync.strategy.type} signer/tx layers ready`)

  console.log('[reconcile] reading active bin snapshot')
  const snap = await pool.snapshot()
  console.log(`[reconcile] activeBin=${snap.activeBin} — scanning ±50 bin positions`)
  const positions = await pool.safeBinPositions(snap.activeBin, 50)
  console.log(`[reconcile] ${positions.length} positions found`)
  const currentCenter =
    positions.length === 0 ? null : Math.round(positions.reduce((a, p) => a + p.id, 0) / positions.length)
  stateManager.update({ currentCenter })

  stateManager.transition('OPERATIONAL', { reason: 'reconciled' })
  console.log('[reconcile] → OPERATIONAL')
}

async function operationalTick(sync: SyncResponse) {
  if (!pool || !tx || !strategy) {
    stateManager.transition('PAUSED', { reason: 'operational without pool/tx/strategy' })
    return
  }

  if (sync.strategy && sync.strategy.type !== strategy.id) {
    strategy = buildStrategy(sync.strategy)
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

  const interval = setInterval(async () => {
    try {
      await poll()
    } catch (e) {
      console.error(`[poll] uncaught: ${e}`)
      if (e instanceof Error && e.stack) console.error(e.stack)
    }
  }, (lastSync?.syncPollIntervalSeconds ?? 30) * 1000)

  void interval
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
