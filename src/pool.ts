import { ethers } from 'ethers'
import { config, rpcUrl } from './config'
import { LB_PAIR_ABI, ERC20_ABI } from './abi'

export const provider = new ethers.JsonRpcProvider(rpcUrl(), 8453, {
  staticNetwork: true,
})

export const wallet = new ethers.Wallet(config.privateKey, provider)

export const pool = new ethers.Contract(config.poolAddress, LB_PAIR_ABI, wallet)
export const dclaw = new ethers.Contract(config.dclawAddress, ERC20_ABI, wallet)
export const weth = new ethers.Contract(config.wethAddress, ERC20_ABI, wallet)

export interface PoolSnapshot {
  reserveX: bigint
  reserveY: bigint
  activeId: number
  blockNumber: number
  timestamp: number
}

export async function snapshot(): Promise<PoolSnapshot> {
  const [block, [reserveX, reserveY, activeId]] = await Promise.all([
    provider.getBlock('latest'),
    pool.getReservesAndId() as Promise<[bigint, bigint, bigint]>,
  ])
  if (!block) throw new Error('No latest block from RPC')
  return {
    reserveX,
    reserveY,
    activeId: Number(activeId),
    blockNumber: block.number,
    timestamp: block.timestamp,
  }
}

export async function balances(addr: string): Promise<{ weth: bigint; dclaw: bigint; eth: bigint }> {
  const [w, d, e] = await Promise.all([
    weth.balanceOf(addr) as Promise<bigint>,
    dclaw.balanceOf(addr) as Promise<bigint>,
    provider.getBalance(addr),
  ])
  return { weth: w, dclaw: d, eth: e }
}

// Bin ID 2^23 is the "center" where price (tokenY per tokenX, raw) = 1.0.
// price(bin) = (1 + binStep/10000)^(bin - 2^23). Each bin is binStep bps wide.
const BIN_CENTER = 2 ** 23

export function binToPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10000, binId - BIN_CENTER)
}

// Find which of our LB token IDs (bin shares) the wallet currently holds.
// Returns the IDs and amounts for a range of bin IDs (sliding window).
export async function walletBinPositions(
  addr: string,
  centerBin: number,
  radius = 32,
): Promise<{ id: number; shares: bigint }[]> {
  const ids: number[] = []
  for (let i = -radius; i <= radius; i++) ids.push(centerBin + i)
  const calls = ids.map((id) => pool.balanceOf(addr, id) as Promise<bigint>)
  const results = await Promise.all(calls)
  return ids
    .map((id, i) => ({ id, shares: results[i] }))
    .filter((p) => p.shares > 0n)
}
