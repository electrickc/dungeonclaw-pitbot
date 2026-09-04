import { ethers } from 'ethers'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config'
import { ControlPlaneClient, SyncResponse } from './controlPlane'
import { BotStateManager } from './state'
import { createChainAdapter } from './chain/factory'
import type { ChainAdapter } from './chain/types'
import { buildStrategy, Strategy } from './strategy'
import { decide } from './trigger'
import { withTimeout } from './util/withTimeout'
import { ERC20_ABI } from './abi'

const RPC_TIMEOUT_MS = 20_000
const RECONCILE_TIMEOUT_SECONDS = 90
// Per-tick bin scan half-width. Normal price motion between ticks stays well
// inside this; kept small because safeBinPositions does one balanceOf per bin.
const RECONCILE_SCAN_WINDOW = 50
// One-time restart fallback half-width, used ONLY when the ±50 sweep finds
// nothing — covers a large price gap during downtime so an existing position
// isn't missed and double-minted. ~2× the cost of a normal scan, paid rarely.
const RECONCILE_WIDE_SCAN_WINDOW = 200
// Consecutive failed mints (e.g. active-bin front-run reverts) before the bot
// stops retrying and pauses for an operator. Prevents an attacker from griefing
// a burned-but-not-reminted position into an unbounded idle-capital retry loop.
const MAX_CONSECUTIVE_MINT_FAILURES = 3
// Single-poll price move (as a fraction) beyond which a mint is deferred one
// tick by the manipulation guard. Expressed in price terms so it means the same
// thing on every pair regardless of binStep; converted to a bin count per-pool
// via binStepToJumpBins(). Operators can override per pool with the
// `manipulationJumpBins` strategy knob.
const MANIPULATION_JUMP_PCT = 0.2 // 20% in one ~30s poll = suspicious

/**
 * Convert the price-% manipulation threshold into a bin count for a given
 * binStep. One bin is a (1 + binStep/1e4) price ratio, so N bins ≈ that ratio
 * to the Nth power; invert to get the bins that correspond to a MANIPULATION_
 * JUMP_PCT move. Floors at 3 so tiny-binStep pairs still tolerate a few bins of
 * ordinary noise, and guards against a zero/negative binStep.
 */
function binStepToJumpBins(binStep: number): number {
  if (!Number.isFinite(binStep) || binStep <= 0) return Infinity
  const perBin = Math.log(1 + binStep / 10_000)
  const bins = Math.ceil(Math.log(1 + MANIPULATION_JUMP_PCT) / perBin)
  return Math.max(3, bins)
}

const cfg = loadConfig()
const stateManager = new BotStateManager(cfg.statePath)
const cp = new ControlPlaneClient({
  baseUrl: cfg.controlPlaneUrl,
  token: cfg.controlPlaneToken,
  poolId: cfg.poolId,
})

let consecutiveSyncFailures = 0
let lastSync: SyncResponse | null = null
// Hold-reason log throttle. Hysteresis can hold for hours during ranging
// markets — logging every tick spams ~2880 lines/day per pool.
let lastTickReason = ''
let holdLogCounter = 0
// Consecutive place/reposition mint failures. Reset on any successful mint;
// when it hits MAX_CONSECUTIVE_MINT_FAILURES the bot pauses (see operationalTick).
let consecutiveMintFailures = 0
// Active bin seen on the previous operationalTick. Feeds the manipulation
// guard's single-poll jump measurement. Reset to null whenever we leave the
// OPERATIONAL loop (reconcile/pause) so a stale pre-downtime reading can't
// register a false "jump" on the first tick back.
let lastObservedActiveBin: number | null = null
// Chain-agnostic adapter — replaces the previous (pool, signer, tx) triplet.
// Reconcile picks an EvmAdapter or SolanaAdapter via `createChainAdapter`
// based on `cfg.chainKind`. The strategy/trigger never touch chain-specific
// primitives — they consume the adapter's `snapshot()` / `mint()` / etc.
let chain: ChainAdapter | null = null
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

// Sweep the bot signer's leftover native gas to the Safe (on retire). Leaves a
// small reserve to pay for this very transfer. EVM chains only — the bot signer
// holds native ETH for gas on both Base and Robinhood.
async function returnGasToSafe(safeAddress: string): Promise<void> {
  if (cfg.chainKind !== 'evm') return
  try {
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl)
    const wallet = ensureBotWallet().connect(provider)
    const bal = await provider.getBalance(wallet.address)
    const fee = await provider.getFeeData()
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n
    // Reserve 21000 (plain transfer) × price × 3 as a safety buffer.
    const reserve = 21_000n * gasPrice * 3n
    if (bal <= reserve) {
      console.log(`[retire] gas ${bal} wei <= reserve ${reserve} — nothing to return`)
      return
    }
    const value = bal - reserve
    console.log(`[retire] returning ${value} wei gas to Safe ${safeAddress}`)
    const tx = await wallet.sendTransaction({ to: safeAddress, value })
    const receipt = await tx.wait()
    console.log(`[retire] gas returned: ${tx.hash} status=${receipt?.status}`)
    try {
      await cp.emitEvent({ ts: Math.floor(Date.now() / 1000), type: 'gas_returned', payload: { hash: tx.hash, to: safeAddress, value: value.toString() } })
    } catch { /* best-effort event */ }
  } catch (e) {
    console.error(`[retire] gas return failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Sweep ERC-20 tokens (and leftover native gas) that were mistakenly sent to
 * the bot's own EOA out to the pool's Safe. ERC-20 transfers happen FIRST
 * (they need gas); the native sweep is last (via returnGasToSafe).
 *
 * Idempotent: tokens with a zero balance are silently skipped, so re-running
 * after a partial sweep is safe.
 */
async function recoverTokensToSafe(
  safeAddress: string,
  tokenAddrs: string[],
): Promise<{
  swept: { token: string; symbol?: string; amount: string }[]
  errors: { token: string; error: string }[]
}> {
  const swept: { token: string; symbol?: string; amount: string }[] = []
  const errors: { token: string; error: string }[] = []

  if (cfg.chainKind !== 'evm') {
    console.log('[recover] non-EVM chain — skipping token recovery')
    return { swept, errors }
  }
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl)
  const wallet = ensureBotWallet().connect(provider)
  const botAddress = wallet.address

  // Deduplicate and remove falsy values.
  const unique = [...new Set(tokenAddrs.filter(Boolean))]

  for (const tokenAddr of unique) {
    try {
      const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, wallet)
      const balance: bigint = await erc20.balanceOf(botAddress)
      if (balance === 0n) {
        console.log(`[recover] ${tokenAddr}: balance=0 — skip`)
        continue
      }
      let symbol: string | undefined
      try { symbol = await erc20.symbol() } catch { /* optional */ }
      console.log(`[recover] ${tokenAddr} (${symbol ?? '?'}): transferring ${balance} to Safe ${safeAddress}`)
      const tx = await erc20.transfer(safeAddress, balance)
      await tx.wait()
      console.log(`[recover] ${tokenAddr}: transfer confirmed tx=${tx.hash}`)
      swept.push({ token: tokenAddr, symbol, amount: balance.toString() })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[recover] ${tokenAddr}: failed — ${error}`)
      errors.push({ token: tokenAddr, error })
      // Continue with remaining tokens.
    }
  }

  // Native sweep LAST (tokens need gas; once gas is swept this EOA is dry).
  // Guarded so a native-sweep failure surfaces in `errors` (preserving the
  // control plane's retry signal) instead of aborting. returnGasToSafe already
  // swallows its own errors, so this catch is defense-in-depth.
  try {
    await returnGasToSafe(safeAddress)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`[recover] native sweep failed — ${error}`)
    errors.push({ token: 'native', error })
  }

  return { swept, errors }
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
          reason: `recoverable:control plane unreachable: ${errMsg} (${consecutiveSyncFailures}/${lastSync.consecutiveSyncFailureThreshold})`,
        })
      }
    }
    return
  }

  if (sync.status === 'retired') {
    // Final act: return leftover gas ETH to the Safe. The bot signer's key is
    // enclave-only, so this is the ONLY way its residual gas can be recovered —
    // once this enclave dies the key (and any un-swept ETH) is gone forever.
    if (sync.safeAddress) await returnGasToSafe(sync.safeAddress)
    stateManager.transition('RETIRED', { reason: 'retired by control plane' })
    process.exit(0)
  }

  // Token-recovery sweep: runs even while paused so a mis-sent token can always
  // be recovered without resuming bot operations. The control plane clears
  // recoverToSafe when it sees the 'tokens_recovered' event.
  if (sync.recoverToSafe && sync.safeAddress) {
    const tokenAddrs = [sync.tokenXAddress, sync.tokenYAddress].filter(Boolean) as string[]
    const { swept, errors } = await recoverTokensToSafe(sync.safeAddress, tokenAddrs)
    try {
      // Emit unconditionally; the control plane clears recoverToSafe ONLY when
      // `errors` is empty. Idempotent success (all balances already 0) yields
      // swept:[] errors:[] → flag cleared. Any failure keeps errors non-empty
      // → flag stays set → retried next poll.
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: 'tokens_recovered',
        payload: { safeAddress: sync.safeAddress, swept, errors },
      })
    } catch (e) {
      console.error(`[recover] event emit failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
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
        stateManager.transition('PAUSED', { reason: `recoverable:reconcile timeout (${elapsedSec}s)` })
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
        // On resume, rebuild the strategy from the control plane's CURRENT
        // value. This catches the case where the operator paused us via
        // strategy change, then either confirmed or reverted before resuming
        // — either way, we adopt whatever the control plane says NOW.
        if (sync.strategy && strategy && sync.strategy.type !== strategy.id) {
          console.log(`[paused→resume] adopting strategy ${strategy.id} → ${sync.strategy.type}`)
          strategy = buildStrategy(sync.strategy)
        }
        lastObservedActiveBin = null // fresh jump reference on resume
        stateManager.transition('OPERATIONAL', { reason: 'resumed' })
        break
      }
      // Don't fight the operator: if the control plane explicitly says
      // "paused", skip self-heal entirely — the operator chose to stop us.
      if (sync.status === 'paused' || sync.killSwitch) break
      // Self-heal gate: only retry reconcile when the pause reason was
      // explicitly tagged `recoverable:` at emit time. Substring matching
      // on "reconcile error" was too broad — terminal errors (wrong chainId,
      // Safe owner mismatch, missing approvals) ALSO carry that prefix and
      // would be self-healed every 60s, burning RPC quota.
      const reason = stateManager.snapshot.reason
      const isSelfHealable = reason.startsWith('recoverable:')
      const SELF_HEAL_BACKOFF_S = 60
      const sinceLastAttempt = (Date.now() / 1000) - stateManager.snapshot.lastTransitionTs
      if (isSelfHealable && sinceLastAttempt >= SELF_HEAL_BACKOFF_S &&
          sync.safeAddress && sync.helperAddress && sync.pairAddress && sync.strategy) {
        console.log('[paused] attempting recovery via reconcile')
        try {
          stateManager.transition('PENDING_SAFE_SETUP', { reason: 'recoverable:retry from paused' })
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

    // Token discovery: read tokenX/tokenY off-chain from the pair account.
    // EVM uses TJ LB v2's `tokenX()` / `tokenY()` view functions; Solana
    // would read the Meteora pool account directly. Inlined per-chain
    // here pre-adapter because the adapter constructor needs the resolved
    // addresses. Phase B: move into SolanaAdapter's own bootstrap path.
    let tokenX: string, tokenY: string
    if (cfg.chainKind === 'evm') {
      console.log(`[reconcile] reading tokens via EVM RPC ${cfg.rpcUrl.slice(0, 40)}...`)
      const tempProvider = new ethers.JsonRpcProvider(cfg.rpcUrl)
      const tempPair = new ethers.Contract(
        sync.pairAddress,
        ['function tokenX() view returns (address)', 'function tokenY() view returns (address)'],
        tempProvider,
      )
      ;[tokenX, tokenY] = await withTimeout(
        Promise.all([tempPair.tokenX(), tempPair.tokenY()]),
        RPC_TIMEOUT_MS,
        'tokens',
      )
    } else {
      // Phase B: Solana token discovery via Meteora pool account read.
      throw new Error('Solana token discovery not yet implemented (Phase B)')
    }
    console.log(`[reconcile] tokenX=${tokenX} tokenY=${tokenY}`)

    // Build the chain adapter. Picks EvmAdapter or SolanaAdapter based on
    // `cfg.chainKind`. The adapter encapsulates all chain-specific signing,
    // RPC, and contract decoding — the rest of reconcile is chain-agnostic.
    chain = await createChainAdapter({
      kind: cfg.chainKind,
      rpcUrl: cfg.rpcUrl,
      botPrivateKey: wallet.privateKey,
      expectedChainId: cfg.expectedChainId,
      addrs: {
        pair: sync.pairAddress,
        helper: sync.helperAddress,
        custody: sync.safeAddress,
        tokenX,
        tokenY,
      },
    })

    // chainId assertion via adapter. Each adapter knows its expected chain
    // (8453 for EVM Base; 'solana-mainnet' for Solana) and exposes
    // `getChainId()` that throws or returns the live value. Comparing
    // against the adapter's static `chainId` catches RPC misconfig early.
    const liveChainId = await withTimeout(chain.getChainId(), RPC_TIMEOUT_MS, 'getChainId')
    if (liveChainId !== chain.chainId) {
      throw new Error(`unexpected chainId ${liveChainId} (expected ${chain.chainId}) — check RPC_URL`)
    }

    console.log('[reconcile] ensuring helper approvals')
    await withTimeout(chain.ensureApprovals(), RPC_TIMEOUT_MS * 3, 'ensureApprovals')

    console.log('[reconcile] validating invariants')
    await withTimeout(chain.validateInvariants(), RPC_TIMEOUT_MS, 'invariants')
    console.log('[reconcile] invariants OK')

    strategy = buildStrategy(sync.strategy)
    console.log(`[reconcile] strategy=${sync.strategy.type} adapter=${chain.kind} ready`)

    console.log('[reconcile] reading active bin snapshot')
    const snap = await withTimeout(chain.snapshot(), RPC_TIMEOUT_MS, 'snapshot')
    console.log(`[reconcile] activeBin=${snap.activeBin} — scanning ±${RECONCILE_SCAN_WINDOW} bin positions`)
    let positions = await withTimeout(
      chain.safeBinPositions(snap.activeBin, RECONCILE_SCAN_WINDOW),
      RPC_TIMEOUT_MS,
      'binPositions',
    )
    // Empty is the dangerous case on restart: if price gapped beyond the scan
    // window while the bot was down, an existing (e.g. wall) position sits
    // outside ±RECONCILE_SCAN_WINDOW and reads as "no position" — the bot would
    // then mint a SECOND position and orphan the first. Before concluding there
    // is nothing to recover, do one wide fallback sweep. Only the empty path
    // pays this cost, so healthy restarts stay cheap.
    if (positions.length === 0) {
      console.log(`[reconcile] no positions in ±${RECONCILE_SCAN_WINDOW} — wide fallback sweep ±${RECONCILE_WIDE_SCAN_WINDOW}`)
      positions = await withTimeout(
        chain.safeBinPositions(snap.activeBin, RECONCILE_WIDE_SCAN_WINDOW),
        RPC_TIMEOUT_MS * 3,
        'binPositionsWide',
      )
    }
    console.log(`[reconcile] ${positions.length} positions found`)
    // Share-weighted center: a one-sided wall/bid-ask strategy distributes
    // shares asymmetrically, so an unweighted arithmetic mean of bin IDs lands
    // off the true mint center, which makes the very next operationalTick
    // see a fake drift > threshold and burn the freshly-minted position.
    // Falls back to arithmetic if every position's share is zero (defensive).
    let currentCenter: number | null = null
    if (positions.length > 0) {
      // Prefer the strategy's own anchor recovery. For asymmetric shapes (wall,
      // bid-ask) the drift anchor is the activeBin the position was built around,
      // NOT the share-weighted centroid — the centroid sits offset from active
      // and would make drift permanently exceed threshold, hot-looping rebalance.
      // Symmetric strategies omit anchorBin() and fall through to the centroid,
      // which equals the anchor for a symmetric layout.
      const anchor = strategy?.anchorBin?.(positions.map((p) => p.id))
      if (anchor != null) {
        currentCenter = anchor
      } else {
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
    }
    // Bot native-gas balance gate. EVM: 0.0005 ETH ≈ ~100 rebalances at
    // typical Base gas; Solana: ~0.005 SOL covers comparable priority fees.
    // Without enough balance the bot can't pay gas and every tick reverts
    // opaquely. Catch loud at reconcile so the control plane sees a
    // structured `bot_eth_low` (or `bot_sol_low`) instead of opaque reverts.
    const MIN_BOT_GAS = chain.kind === 'evm'
      ? 500_000_000_000_000n   // 0.0005 ETH
      : 5_000_000n             // 0.005 SOL (1 SOL = 1e9 lamports)
    try {
      const balance = await chain.getBotBalance()
      console.log(`[reconcile] bot signer balance: ${balance.toString()} (${chain.botAddress})`)
      if (balance < MIN_BOT_GAS) {
        const reason = chain.kind === 'evm' ? 'bot_eth_low' : 'bot_sol_low'
        stateManager.transition('PAUSED', {
          reason: `${reason}: have ${balance.toString()}, need ${MIN_BOT_GAS.toString()}`,
        })
        try {
          await cp.emitEvent({
            ts: Math.floor(Date.now() / 1000),
            type: 'error',
            payload: { reason, balance: balance.toString(), botAddress: chain.botAddress },
          })
        } catch { /* best effort */ }
        return
      }
    } catch (e) {
      console.warn(`[reconcile] bot balance check failed: ${e}`)
    }
    stateManager.update({ currentCenter })

    lastObservedActiveBin = null // fresh jump reference after reconcile
    stateManager.transition('OPERATIONAL', { reason: 'reconciled' })
    console.log(`[reconcile] done in ${Date.now() - startMs}ms`)
    console.log('[reconcile] → OPERATIONAL')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[reconcile] error: ${msg}`)
    // Classify by error message. Terminal config errors (wrong chainId,
    // helper bound to wrong Safe, missing approvals) should NOT self-heal —
    // they'd hammer RPC every 60s for free. Two recoverable cases:
    //   1. Bot wallet not yet a Safe owner (wizard races provision + addOwner).
    //   2. Generic RPC/network blips (timeouts, ECONNRESET, etc.).
    const lower = msg.toLowerCase()
    const isRecoverable =
      lower.includes('is not a safe owner') ||
      lower.includes('timeout') ||
      lower.includes('econnreset') ||
      lower.includes('socket') ||
      lower.includes('network') ||
      lower.includes('etimedout')
    const reasonPrefix = isRecoverable ? 'recoverable:reconcile error:' : 'reconcile error:'
    stateManager.transition('PAUSED', { reason: `${reasonPrefix} ${msg}` })
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
  if (!chain || !strategy) {
    // Spell out which dependency is null so the operator doesn't have to guess.
    const missing = [
      chain ? null : 'chain',
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
    //
    // Defer the in-memory strategy swap until AFTER the operator resumes.
    // If we rebuild here and the operator reverts the change before resuming,
    // the next tick sees in-memory strategy.id matching the reverted type
    // and no longer detects a change — surprising no-op.
    const oldId = strategy.id
    console.log(`[op] strategy change detected: ${oldId} → ${sync.strategy.type}`)
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

  const snap = await chain.snapshot()
  const positions = await chain.safeBinPositions(snap.activeBin, 50)
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

  // Per-pair jump limit: operator knob override, else derived from binStep so a
  // 20% single-poll move maps to the right bin count for this market.
  const jumpKnob = sync.strategy?.knobs.manipulationJumpBins
  const manipulationJumpBins = typeof jumpKnob === 'number' && jumpKnob > 0
    ? jumpKnob
    : binStepToJumpBins(snap.binStep)

  // Deployed range edges from the bot's actual held bins (safeBinPositions
  // returns only bins with shares > 0). These drive the edge-based rebalance
  // trigger: reposition only once the active bin exits [heldMinBin, heldMaxBin]
  // — i.e. one bin past the last edge — rather than on a small drift from center.
  const heldIds = positions.map((p) => p.id)
  const heldMinBin = heldIds.length ? Math.min(...heldIds) : null
  const heldMaxBin = heldIds.length ? Math.max(...heldIds) : null

  const action = decide({
    activeBin: snap.activeBin,
    currentCenter: stateManager.snapshot.currentCenter,
    lastRebalanceTs: stateManager.snapshot.lastRebalanceTs,
    lastRebalanceCenter: stateManager.snapshot.lastRebalanceCenter ?? null,
    nowTs: Math.floor(Date.now() / 1000),
    anyBinFilled,
    rebalanceCooldownSeconds: sync.rebalanceCooldownSeconds,
    rebalanceBinsThreshold: sync.strategy?.knobs.rebalanceBinsThreshold ?? 2,
    lastObservedActiveBin,
    manipulationJumpBins,
    heldMinBin,
    heldMaxBin,
  })

  // Advance the jump reference AFTER deciding, every tick (even on hold), so a
  // sustained move confirms on the next poll (jump shrinks once price settles)
  // while a one-tick spike is measured against the pre-spike level exactly once.
  lastObservedActiveBin = snap.activeBin

  // Throttle hold-reason logging: hysteresis can hold for hours during
  // ranging markets; logging every 30s tick = 2880 lines/day per pool.
  // Log transitions and non-hold actions every tick; log hold-with-same-
  // reason only every 10 ticks (~5 min).
  const reasonChanged = action.reason !== lastTickReason
  lastTickReason = action.reason
  if (action.action !== 'hold' || reasonChanged || ++holdLogCounter >= 10) {
    if (action.action === 'hold' && !reasonChanged) holdLogCounter = 0
    console.log(`[tick] active=${snap.activeBin} action=${action.action} reason=${action.reason}`)
  }

  if (action.action === 'hold') return

  try {
    if (action.action === 'withdraw_filled') {
      const ids = positions.map((p) => p.id)
      const shares = positions.map((p) => p.shares)
      const receipt = await chain.burn(ids, shares)
      stateManager.update({ currentCenter: null, lastRebalanceTs: Math.floor(Date.now() / 1000) })
      await cp.emitEvent({
        ts: Math.floor(Date.now() / 1000),
        type: 'withdraw',
        payload: { txHash: receipt.hash, binIds: ids, shareTotal: shares.reduce((a, b) => a + b, 0n).toString() },
      })
    } else {
      // Reposition / place: burn existing LP, then re-mint around the fresh
      // active bin. These are two separate Safe txs; between them the Safe holds
      // idle inventory with no LP. If the mint fails — e.g. a searcher front-runs
      // the active bin so the plan's bins are mis-sided and LB rejects the
      // composition — the burned position is already gone, so clear currentCenter
      // right after the burn. The next tick then re-places from a fresh snapshot
      // instead of reasoning about a stale center, and the failure counter below
      // bounds how long a griefer can pin the capital idle.
      if (positions.length > 0) {
        const ids = positions.map((p) => p.id)
        const shares = positions.map((p) => p.shares)
        await chain.burn(ids, shares)
        stateManager.update({ currentCenter: null })
      }
      const updatedSnap = await chain.snapshot()
      const plan = strategy.plan({
        activeBin: updatedSnap.activeBin,
        xAvailable: updatedSnap.safeXBalance,
        yAvailable: updatedSnap.safeYBalance,
        binStep: updatedSnap.binStep,
      })
      const receipt = await chain.mint(plan)
      // A mined-but-reverted mint returns status 'reverted' (not a throw). Treat
      // it the same as a thrown failure so the grief counter and idle-capital
      // handling in catch{} apply.
      if (receipt.status === 'reverted') {
        throw new Error(`mint reverted (tx=${receipt.hash}) — active bin likely moved between plan and inclusion`)
      }
      consecutiveMintFailures = 0
      // Anchor drift tracking to the activeBin the plan was built around — NOT
      // the bin centroid. For asymmetric shapes (wall, one-sided bid-ask) the
      // centroid is deliberately offset from active, so anchoring to it made
      // drift = |active - centroid| permanently exceed threshold, hot-looping
      // burn+remint every cooldown. Anchoring to active means we only rebalance
      // when price actually moves away from where we built the position.
      const newCenter = updatedSnap.activeBin
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
    // Bound the idle-capital grief loop. A place/reposition burns first, so a
    // repeatedly-failing mint (front-run or sharp volatility) leaves inventory
    // idle in the Safe. After N consecutive failures, pause for the operator
    // rather than retrying every tick forever. withdraw_filled is exempt — it's
    // a pure burn with no re-mint, so a failure there doesn't strand LP.
    if (action.action !== 'withdraw_filled') {
      consecutiveMintFailures += 1
      if (consecutiveMintFailures >= MAX_CONSECUTIVE_MINT_FAILURES) {
        console.error(`[op] ${consecutiveMintFailures} consecutive mint failures — pausing for operator`)
        stateManager.transition('PAUSED', {
          reason: `recoverable:mint failed ${consecutiveMintFailures}× — active-bin front-run or volatility; inventory idle in Safe`,
        })
        try {
          await cp.emitEvent({
            ts: Math.floor(Date.now() / 1000),
            type: 'error',
            payload: { reason: 'mint_repeated_failure', count: consecutiveMintFailures },
          })
        } catch { /* best effort */ }
        consecutiveMintFailures = 0
      }
    }
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
