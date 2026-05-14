import { ethers } from 'ethers'
import { config } from './config'
import { snapshot, balances, walletBinPositions, wallet } from './pool'
import { PriceTracker } from './price'
import { buildWallPlan, decide } from './strategy'
import {
  transferWethToPool,
  mintWall,
  burnWall,
  wethBalance,
  dclawBalance,
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

  const snap = await snapshot()
  tracker.push(snap.activeId, snap.timestamp)

  // Detect whether any of our wall bins have already been "consumed" by sells.
  // A bin below the current active that we held: if its X reserve is non-zero,
  // it has accumulated DCLAW = we got filled there.
  let anyBinFilled = false
  if (state.wallCenterBin !== null) {
    const positions = await walletBinPositions(
      wallet.address,
      state.wallCenterBin,
      Math.max(8, config.wallBinCount + 4),
    )
    for (const p of positions) {
      if (p.id < snap.activeId) {
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

async function main(): Promise<void> {
  console.log(`[boot] pitbot v0.1.0`)
  console.log(`[boot] wallet=${wallet.address}`)
  console.log(`[boot] dryRun=${config.dryRun}, kill=${config.kill}`)
  console.log(
    `[boot] strategy: ${config.skew} skew, ${config.wallBinCount} bins, offset ${config.binOffsetFromActive}, budget ${config.totalWethBudget} WETH`,
  )

  const bal = await balances(wallet.address)
  console.log(
    `[boot] balances: ETH=${ethers.formatEther(bal.eth)} WETH=${ethers.formatEther(bal.weth)} DCLAW=${ethers.formatEther(bal.dclaw)}`,
  )

  await reconstructWallFromChain()

  await emit({
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
  })

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

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
