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
//
// Uses ERC-1155 balanceOfBatch — a SINGLE RPC call returns balances for all
// 2*radius+1 bins at once. Previously this fired N parallel balanceOf calls
// (up to 65 with default radius), which routinely tripped dRPC rate limits.
export async function walletBinPositions(
  addr: string,
  centerBin: number,
  radius = 32,
): Promise<{ id: number; shares: bigint }[]> {
  const ids: number[] = []
  const accounts: string[] = []
  for (let i = -radius; i <= radius; i++) {
    ids.push(centerBin + i)
    accounts.push(addr)
  }
  const results = (await pool.balanceOfBatch(accounts, ids)) as bigint[]
  return ids
    .map((id, i) => ({ id, shares: results[i] }))
    .filter((p) => p.shares > 0n)
}

// Detect ORPHANED LB shares: LB tokens we transferred to the pool during a
// withdraw cycle that crashed before the burn() call. They sit at the pool's
// own address; anyone can burn them via pool.burn(ids, amounts, anyAddress).
//
// Recovery strategy: query our most recent DepositedToBin events to identify
// bins we've minted into recently. For each, check if the pool currently
// holds LB shares there. If so AND we don't hold any ourselves AND the pool's
// holdings are at most what we deposited → it's our orphan, burn it back.
export interface OrphanedBin {
  id: number
  poolBalance: bigint
}

export async function findOrphanedBins(
  selfAddress: string,
  lookbackBlocks = 50000,
): Promise<OrphanedBin[]> {
  const head = await provider.getBlockNumber()
  const fromBlock = Math.max(0, head - lookbackBlocks)

  // Query DepositedToBin events filtered to our wallet as recipient.
  // event DepositedToBin(address indexed sender, address indexed recipient, uint256 indexed id, uint256 amountX, uint256 amountY)
  const filter = {
    address: pool.target as string,
    topics: [
      ethers.id('DepositedToBin(address,address,uint256,uint256,uint256)'),
      null,
      ethers.zeroPadValue(selfAddress, 32),
    ],
    fromBlock,
    toBlock: head,
  }
  const logs = await provider.getLogs(filter)

  // Unique bins we've deposited into recently
  const ourBins = new Set<number>()
  for (const log of logs) {
    if (log.topics[3]) ourBins.add(Number(BigInt(log.topics[3])))
  }
  if (ourBins.size === 0) return []

  // For each candidate bin, check (pool balance, our balance) in parallel.
  const binIds = Array.from(ourBins)
  const accounts: string[] = []
  const idsForCall: number[] = []
  for (const id of binIds) {
    accounts.push(pool.target as string)
    idsForCall.push(id)
    accounts.push(selfAddress)
    idsForCall.push(id)
  }
  const balances = (await pool.balanceOfBatch(accounts, idsForCall)) as bigint[]

  const orphans: OrphanedBin[] = []
  for (let i = 0; i < binIds.length; i++) {
    const poolBalance = balances[i * 2]
    const ourBalance = balances[i * 2 + 1]
    if (poolBalance > 0n && ourBalance === 0n) {
      orphans.push({ id: binIds[i], poolBalance })
    }
  }
  return orphans
}
