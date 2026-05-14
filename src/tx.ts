import { ethers } from 'ethers'
import { config } from './config'
import { wallet, provider, pool, weth, dclaw } from './pool'
import type { WallPlan } from './strategy'
import { distributionX, distributionY } from './strategy'

const MAX_GAS_WEI = BigInt(config.maxGasGwei) * 10n ** 9n

// Refuse to broadcast if base fee exceeds our ceiling. Caller decides whether
// to wait or skip.
async function gasOk(): Promise<{ ok: boolean; feeWei: bigint }> {
  const block = await provider.getBlock('latest')
  if (!block || block.baseFeePerGas === null) return { ok: true, feeWei: 0n }
  const feeWei = block.baseFeePerGas
  return { ok: feeWei <= MAX_GAS_WEI, feeWei }
}

export interface TxResult {
  hash: string
  blockNumber?: number
  status: 'success' | 'reverted'
}

async function send(label: string, txReq: ethers.TransactionRequest): Promise<TxResult> {
  if (config.dryRun) {
    console.log(`[DRY] ${label}`, {
      to: txReq.to,
      data: typeof txReq.data === 'string' ? (txReq.data as string).slice(0, 26) + '…' : null,
      value: txReq.value?.toString() ?? '0',
    })
    return { hash: '0xDRY_RUN', status: 'success' }
  }
  const gas = await gasOk()
  if (!gas.ok) {
    throw new Error(
      `Gas above ceiling: ${gas.feeWei} > ${MAX_GAS_WEI} (MAX_GAS_GWEI=${config.maxGasGwei})`,
    )
  }
  const populated = await wallet.populateTransaction({
    ...txReq,
    nonce: await wallet.getNonce('pending'),
  })
  const sent = await wallet.sendTransaction(populated)
  const rec = await sent.wait()
  return {
    hash: sent.hash,
    blockNumber: rec?.blockNumber,
    status: rec?.status === 1 ? 'success' : 'reverted',
  }
}

// Step 1 of mint: transfer WETH to the pool.
export async function transferWethToPool(amount: bigint): Promise<TxResult> {
  const data = weth.interface.encodeFunctionData('transfer', [config.poolAddress, amount])
  return send('transferWethToPool', { to: config.wethAddress, data, value: 0n })
}

// Step 2 of mint: tell the pool how to distribute the just-transferred WETH
// across the wall bins. distributionY must sum to 1e18.
export async function mintWall(plan: WallPlan): Promise<TxResult> {
  const ids = plan.binIds.map((b) => BigInt(b))
  const distX = distributionX(plan)
  const distY = distributionY(plan)
  const data = pool.interface.encodeFunctionData('mint', [
    ids,
    distX,
    distY,
    wallet.address,
  ])
  return send('mintWall', { to: config.poolAddress, data, value: 0n })
}

// Withdraw all shares we hold across the given bins. amounts = total LB tokens
// per bin to burn (typically the entire wallet balance for each).
export async function burnWall(
  binIds: number[],
  shares: bigint[],
): Promise<TxResult> {
  if (binIds.length !== shares.length) throw new Error('burn arrays mismatched')
  const ids = binIds.map((b) => BigInt(b))
  const data = pool.interface.encodeFunctionData('burn', [ids, shares, wallet.address])
  return send('burnWall', { to: config.poolAddress, data, value: 0n })
}

export async function wethBalance(): Promise<bigint> {
  return (await weth.balanceOf(wallet.address)) as bigint
}

export async function dclawBalance(): Promise<bigint> {
  return (await dclaw.balanceOf(wallet.address)) as bigint
}
