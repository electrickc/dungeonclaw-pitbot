import { ethers } from 'ethers'
import { config } from './config'
import { snapshot, balances, walletBinPositions, wallet, pool } from './pool'
import { PriceTracker } from './price'
import { buildWallPlan, decide } from './strategy'
import {
  transferWethToPool,
  mintWall,
  burnWall,
  wethBalance,
  dclawBalance,
  transferWethTo,
  transferDclawTo,
} from './tx'
import { emit } from './webhook'

const tracker = new PriceTracker()

interface BotState {
  lastRebalanceTs: number
  // Center bin of the currently-placed wall, or null if no wall.
  wallCenterBin: number | null
  // Cumulative WETH and DCLAW the bot has accumulated (signed wei strings,
  // for the admin's P&L view to aggregate).
  cumulativeWethIn: bigint
  cumulativeDclawIn: bigint
}

const state: BotState = {
  lastRebalanceTs: 0,
  wallCenterBin: null,
  cumulativeWethIn: 0n,
  cumulativeDclawIn: 0n,
}

// On startup, reconstruct wall state by scanning the bins around current active.
async function reconstructWallFromChain(): Promise<void> {
  const snap = await snapshot()
  const positions = await walletBinPositions(wallet.address, snap.activeId, 32)
  if (positions.length === 0) {
    state.wallCenterBin = null
    console.log(`[boot] no existing wall positions found`)
    return
  }
  // Wall center = mean of held bin IDs
  const sum = positions.reduce((a, p) => a + p.id, 0)
  state.wallCenterBin = Math.round(sum / positions.length)
  console.log(
    `[boot] reconstructed wall: ${positions.length} bins held, center ~${state.wallCenterBin}, active ${snap.activeId}`,
  )
}

async function placeWall(activeBin: number): Promise<void> {
  const wethAvail = await wethBalance()
  const budgetWei = ethers.parseEther(config.totalWethBudget)
  const useWei = wethAvail < budgetWei ? wethAvail : budgetWei

  if (useWei === 0n) {
    console.log(`[place] no WETH balance — skipping`)
    await emit({
      type: 'rebalance_skipped',
      ts: Math.floor(Date.now() / 1000),
      activeBin,
      raw: { reason: 'zero WETH balance' },
    })
    return
  }

  const plan = buildWallPlan(activeBin, useWei)
  console.log(
    `[place] active=${activeBin} weth=${ethers.formatEther(useWei)} bins=${plan.binIds.join(',')}`,
  )

  const transferTx = await transferWethToPool(useWei)
  const mintTx = await mintWall(plan)

  // Wall center = midpoint of the planned bins
  const center = Math.round(
    plan.binIds.reduce((a, b) => a + b, 0) / plan.binIds.length,
  )
  state.wallCenterBin = center
  state.lastRebalanceTs = Math.floor(Date.now() / 1000)

  await emit({
    type: 'rebalance_placed',
    ts: state.lastRebalanceTs,
    txHash: mintTx.hash,
    activeBin,
    wallCenterBin: center,
    wethDelta: (-useWei).toString(),
    raw: {
      binIds: plan.binIds,
      weiPerBin: plan.weiPerBin.map((b) => b.toString()),
      transferHash: transferTx.hash,
      skew: config.skew,
    },
  })
}

async function withdrawAll(): Promise<{ wethGained: bigint; dclawGained: bigint }> {
  const wethBefore = await wethBalance()
  const dclawBefore = await dclawBalance()

  const snap = await snapshot()
  const positions = await walletBinPositions(wallet.address, snap.activeId, 32)
  if (positions.length === 0) return { wethGained: 0n, dclawGained: 0n }

  const ids = positions.map((p) => p.id)
  const shares = positions.map((p) => p.shares)
  const burnTx = await burnWall(ids, shares)

  // In dry-run mode, burnTx.hash === '0xDRY_RUN' and balances won't change.
  // We still want the event to fire so the admin can see the intention.
  const wethAfter = await wethBalance()
  const dclawAfter = await dclawBalance()
  const wethGained = wethAfter - wethBefore
  const dclawGained = dclawAfter - dclawBefore

  state.wallCenterBin = null
  state.cumulativeWethIn += wethGained
  state.cumulativeDclawIn += dclawGained

  await emit({
    type: 'withdrawal',
    ts: Math.floor(Date.now() / 1000),
    txHash: burnTx.hash,
    activeBin: snap.activeId,
    wethDelta: wethGained.toString(),
    dclawDelta: dclawGained.toString(),
    raw: { binIds: ids, shares: shares.map((s) => s.toString()) },
  })

  return { wethGained, dclawGained }
}

async function tick(): Promise<void> {
  if (config.kill) {
    console.log('[kill] KILL=1, exiting')
    process.exit(0)
  }

  // FORCE_WITHDRAW: read fresh from env each tick so user can flip via SecretVM
  // env edit + restart without rebuild. When set, the bot:
  //   1. burns ALL held LB positions, recovers WETH+DCLAW to wallet
  //   2. does NOT place a new wall
  //   3. stays in this idle state until FORCE_WITHDRAW is unset/0
  const forceWithdraw =
    process.env.FORCE_WITHDRAW === '1' ||
    (process.env.FORCE_WITHDRAW ?? '').toLowerCase() === 'true'

  const snap = await snapshot()
  tracker.push(snap.activeId, snap.timestamp)

  if (forceWithdraw) {
    const positions = await walletBinPositions(
      wallet.address,
      state.wallCenterBin ?? snap.activeId,
      32,
    )
    if (positions.length > 0) {
      console.log(`[force-withdraw] FORCE_WITHDRAW=1 — burning ${positions.length} LB positions`)
      const r = await withdrawAll()
      console.log(
        `[force-withdraw] complete · WETH ${r.wethGained} DCLAW ${r.dclawGained}`,
      )
    } else {
      console.log(
        '[force-withdraw] no LB positions held.',
      )
    }

    // After burns complete, if WITHDRAW_TO is set, transfer all wallet
    // balances out to that address. Runs on the NEXT tick after burn
    // (when positions.length is now 0).
    const withdrawTo = (process.env.WITHDRAW_TO ?? '').trim()
    const validAddr = /^0x[a-fA-F0-9]{40}$/.test(withdrawTo)
    if (positions.length === 0 && validAddr) {
      const wb = await wethBalance()
      if (wb > 0n) {
        console.log(`[withdraw-to] transferring ${wb} WETH wei → ${withdrawTo}`)
        const tx = await transferWethTo(withdrawTo, wb)
        console.log(`[withdraw-to] WETH tx: ${tx.hash}`)
      }
      const db = await dclawBalance()
      if (db > 0n) {
        console.log(`[withdraw-to] transferring ${db} DCLAW wei → ${withdrawTo}`)
        const tx = await transferDclawTo(withdrawTo, db)
        console.log(`[withdraw-to] DCLAW tx: ${tx.hash}`)
      }
      if (wb === 0n && db === 0n) {
        console.log('[withdraw-to] nothing to send — wallet is empty. Unset WITHDRAW_TO.')
      }
    } else if (positions.length === 0) {
      console.log(
        '[force-withdraw] idling. Set WITHDRAW_TO=0xYourAddress to extract liquid balances out of the bot wallet.',
      )
    }

    await emit({
      type: 'tick',
      ts: snap.timestamp,
      activeBin: snap.activeId,
      raw: {
        decision: { action: 'force_withdraw', reason: 'FORCE_WITHDRAW=1' },
        positions: positions.length,
        withdrawTo: validAddr ? withdrawTo : null,
      },
    }).catch(() => {})
    return // never reach the normal place/reposition path
  }

  // Detect whether any of our wall bins have been "consumed" by sells.
  //
  // Ground truth: check each held bin's actual reserveX. If reserveX > 0,
  // the bin has been swapped through and now holds DCLAW (X) instead of
  // WETH (Y). We do NOT rely on activeId comparison — on SectorOne's pool
  // the active bin tracking is stale / slightly off post-swap, and we
  // observed bins clearly holding DCLAW while still reading id < activeId.
  let anyBinFilled = false
  if (state.wallCenterBin !== null) {
    const positions = await walletBinPositions(
      wallet.address,
      state.wallCenterBin,
      Math.max(8, config.wallBinCount + 4),
    )
    // Parallel getBin lookups across our held bins (max 7-15 calls).
    const binReserves = await Promise.all(
      positions.map(
        (p) => pool.getBin(p.id) as Promise<[bigint, bigint]>,
      ),
    )
    for (let i = 0; i < positions.length; i++) {
      const [reserveX] = binReserves[i]
      if (reserveX > 0n) {
        anyBinFilled = true
        break
      }
    }
  }

  const decision = decide({
    activeBin: snap.activeId,
    hasWall: state.wallCenterBin !== null,
    wallCenterBin: state.wallCenterBin,
    lastRebalanceTs: state.lastRebalanceTs,
    nowTs: snap.timestamp,
    anyBinFilled,
  })

  console.log(
    `[tick] active=${snap.activeId} wallCenter=${state.wallCenterBin} filled=${anyBinFilled} → ${decision.action} (${decision.reason})`,
  )

  await emit({
    type: 'tick',
    ts: snap.timestamp,
    activeBin: snap.activeId,
    wallCenterBin: state.wallCenterBin,
    raw: { decision, anyBinFilled, dryRun: config.dryRun },
  })

  if (decision.action === 'place') {
    await placeWall(snap.activeId)
  } else if (decision.action === 'reposition') {
    await withdrawAll()
    await placeWall(snap.activeId)
  } else if (decision.action === 'withdraw_filled') {
    await withdrawAll()
    // Re-place at the new (lower) active in the same tick so we never go
    // without a bid wall longer than one tick.
    const newSnap = await snapshot()
    await placeWall(newSnap.activeId)
  }
}

// Retry helper for startup RPC reads. Transient dRPC failures (load-balancer
// flips, brief 429s, websocket reconnects) used to kill the container before
// the main loop ever started, triggering Docker's restart-loop. Now we retry
// up to 5 times with exponential backoff before giving up.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const delayMs = Math.min(1000 * 2 ** i, 15000)
      console.warn(
        `[boot] ${label} attempt ${i + 1}/${attempts} failed:`,
        err instanceof Error ? err.message : err,
        `— retrying in ${delayMs}ms`,
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

async function main(): Promise<void> {
  console.log(`[boot] pitbot v0.1.0`)
  console.log(`[boot] wallet=${wallet.address}`)
  console.log(`[boot] dryRun=${config.dryRun}, kill=${config.kill}`)
  console.log(
    `[boot] strategy: ${config.skew} skew, ${config.wallBinCount} bins, offset ${config.binOffsetFromActive}, budget ${config.totalWethBudget} WETH`,
  )

  const bal = await withRetry('balances', () => balances(wallet.address))
  console.log(
    `[boot] balances: ETH=${ethers.formatEther(bal.eth)} WETH=${ethers.formatEther(bal.weth)} DCLAW=${ethers.formatEther(bal.dclaw)}`,
  )

  await withRetry('reconstructWallFromChain', reconstructWallFromChain)

  // Webhook is best-effort; never block boot on it. If admin is down the bot
  // still ticks; once admin recovers it'll see ticks but might miss the boot.
  emit({
    type: 'boot',
    ts: Math.floor(Date.now() / 1000),
    raw: {
      wallet: wallet.address,
      dryRun: config.dryRun,
      eth: bal.eth.toString(),
      weth: bal.weth.toString(),
      dclaw: bal.dclaw.toString(),
      wallCenterBin: state.wallCenterBin,
    },
  }).catch(() => {})

  // Main loop. Top-level catch so one bad tick doesn't kill the bot.
  for (;;) {
    try {
      await tick()
    } catch (err) {
      console.error('[tick] error:', err)
      await emit({
        type: 'error',
        ts: Math.floor(Date.now() / 1000),
        raw: { message: err instanceof Error ? err.message : String(err) },
      }).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalSeconds * 1000))
  }
}

// Belt and braces: capture unhandled promise rejections and uncaught exceptions
// so they go to stdout (visible in `docker logs`) instead of silently killing
// the process. The bot can survive most issues; we'd rather see what broke.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
