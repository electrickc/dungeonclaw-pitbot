import { ethers } from 'ethers'
import { loadConfig } from './config'
import { ControlPlaneClient, SyncResponse } from './controlPlane'
import { BotStateManager } from './state'
import { Pool } from './pool'
import { SafeSigner } from './safeSigner'
import { TxLayer } from './tx'
import { buildStrategy, Strategy } from './strategy/index'
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
let botWallet: ethers.HDNodeWallet | null = null

function ensureBotWallet(): ethers.HDNodeWallet {
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
    rebalanceBinsThreshold: 2,
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
  await poll()

  const interval = setInterval(async () => {
    try {
      await poll()
    } catch (e) {
      console.error(`[poll] uncaught: ${e}`)
    }
  }, (lastSync?.syncPollIntervalSeconds ?? 30) * 1000)

  void interval
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
