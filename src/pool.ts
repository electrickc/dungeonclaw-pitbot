import { ethers } from 'ethers'
import { LB_PAIR_ABI, HELPER_ABI, SAFE_ABI, ERC20_ABI, MULTICALL3_ABI, MULTICALL3_ADDRESS } from './abi'

export interface PoolAddresses {
  pair: string
  helper: string
  safe: string
  tokenX: string
  tokenY: string
}

export interface PoolSnapshot {
  activeBin: number
  binStep: number
  safeXBalance: bigint
  safeYBalance: bigint
}

export interface BinPosition {
  id: number
  shares: bigint
  reserveX: bigint
  reserveY: bigint
}

export class Pool {
  readonly provider: ethers.JsonRpcProvider
  readonly wallet: ethers.Wallet
  readonly pair: ethers.Contract
  readonly helper: ethers.Contract
  readonly safe: ethers.Contract
  readonly tokenX: ethers.Contract
  readonly tokenY: ethers.Contract
  readonly multicall: ethers.Contract
  private cachedBinStep: number | null = null

  constructor(rpcUrl: string, botPrivateKey: string, readonly addrs: PoolAddresses) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true })
    this.wallet = new ethers.Wallet(botPrivateKey, this.provider)
    this.pair = new ethers.Contract(addrs.pair, LB_PAIR_ABI, this.wallet)
    this.helper = new ethers.Contract(addrs.helper, HELPER_ABI, this.wallet)
    this.safe = new ethers.Contract(addrs.safe, SAFE_ABI, this.wallet)
    this.tokenX = new ethers.Contract(addrs.tokenX, ERC20_ABI, this.wallet)
    this.tokenY = new ethers.Contract(addrs.tokenY, ERC20_ABI, this.wallet)
    this.multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.provider)
  }

  async getActiveBin(): Promise<number> {
    const [, , activeId] = await this.pair.getReservesAndId()
    return Number(activeId)
  }

  async getBinStep(): Promise<number> {
    if (this.cachedBinStep != null) return this.cachedBinStep
    const [bs] = await this.pair.feeParameters()
    this.cachedBinStep = Number(bs)
    return this.cachedBinStep
  }

  async snapshot(): Promise<PoolSnapshot> {
    const [activeBin, binStep, safeX, safeY] = await Promise.all([
      this.getActiveBin(),
      this.getBinStep(),
      this.tokenX.balanceOf(this.addrs.safe).then(BigInt),
      this.tokenY.balanceOf(this.addrs.safe).then(BigInt),
    ])
    return { activeBin, binStep, safeXBalance: safeX, safeYBalance: safeY }
  }

  /** Scan a window of bins around activeBin and return positions where Safe holds shares.
   *  Now populates per-bin reserveX/reserveY so the trigger can detect actual fills
   *  (composition shift) rather than relying on "bin is below active" — which was
   *  always true for Wall positions by design, causing a place→withdraw hot loop. */
  async safeBinPositions(activeBin: number, windowSize: number): Promise<BinPosition[]> {
    const start = activeBin - windowSize
    const end = activeBin + windowSize
    const ids: number[] = []
    for (let id = start; id <= end; id++) ids.push(id)
    if (ids.length === 0) return []

    // 1. ONE batched read of the Safe's shares across the whole window. This
    //    replaces the old per-bin balanceOf loop (50-100 sequential eth_calls)
    //    that timed out on slower RPCs.
    const accounts = ids.map(() => this.addrs.safe)
    const sharesRaw: bigint[] = (await this.pair.balanceOfBatch(accounts, ids)).map((s: bigint) => BigInt(s))

    const held = ids
      .map((id, i) => ({ id, shares: sharesRaw[i] ?? 0n }))
      .filter((h) => h.shares > 0n)
    if (held.length === 0) return []

    // 2. ONE multicall for the per-bin reserves of only the held bins.
    const iface = this.pair.interface
    const calls = held.map((h) => ({
      target: this.addrs.pair,
      allowFailure: false,
      callData: iface.encodeFunctionData('getBin', [h.id]),
    }))
    const results: Array<{ success: boolean; returnData: string }> =
      await this.multicall.aggregate3.staticCall(calls)

    const positions: BinPosition[] = []
    for (let i = 0; i < held.length; i++) {
      const [reserveX, reserveY] = iface.decodeFunctionResult('getBin', results[i].returnData)
      positions.push({ id: held[i].id, shares: held[i].shares, reserveX: BigInt(reserveX), reserveY: BigInt(reserveY) })
    }
    return positions
  }

  /** Assert invariants used at RECONCILE state. */
  async validateInvariants(): Promise<void> {
    const isBotOwner = await this.safe.isOwner(this.wallet.address)
    if (!isBotOwner) {
      throw new Error(`bot wallet ${this.wallet.address} is not a Safe owner`)
    }
    // Catch the GS013 footgun: mintAtomic calls transferFrom(Safe, pair, amount)
    // for each token. Zero allowance → revert inside the helper → Safe surfaces
    // it as opaque GS013. Fail loud at reconcile instead.
    const [allowX, allowY, lbApproved] = await Promise.all([
      this.tokenX.allowance(this.addrs.safe, this.addrs.helper).then(BigInt),
      this.tokenY.allowance(this.addrs.safe, this.addrs.helper).then(BigInt),
      this.pair.isApprovedForAll(this.addrs.safe, this.addrs.helper),
    ])
    if (allowX === 0n) {
      throw new Error(`Safe→helper tokenX allowance is 0 — run tokenX.approve(${this.addrs.helper}, max) from the Safe`)
    }
    if (allowY === 0n) {
      throw new Error(`Safe→helper tokenY allowance is 0 — run tokenY.approve(${this.addrs.helper}, max) from the Safe`)
    }
    if (!lbApproved) {
      throw new Error(`pair.isApprovedForAll(Safe, helper) is false — run pair.setApprovalForAll(${this.addrs.helper}, true) from the Safe`)
    }
  }
}
