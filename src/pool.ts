import { ethers } from 'ethers'
import { LB_PAIR_ABI, HELPER_ABI, SAFE_ABI, ERC20_ABI } from './abi'

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
  private cachedBinStep: number | null = null

  constructor(rpcUrl: string, botPrivateKey: string, readonly addrs: PoolAddresses) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true })
    this.wallet = new ethers.Wallet(botPrivateKey, this.provider)
    this.pair = new ethers.Contract(addrs.pair, LB_PAIR_ABI, this.wallet)
    this.helper = new ethers.Contract(addrs.helper, HELPER_ABI, this.wallet)
    this.safe = new ethers.Contract(addrs.safe, SAFE_ABI, this.wallet)
    this.tokenX = new ethers.Contract(addrs.tokenX, ERC20_ABI, this.wallet)
    this.tokenY = new ethers.Contract(addrs.tokenY, ERC20_ABI, this.wallet)
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
    const positions: BinPosition[] = []
    for (let id = start; id <= end; id++) {
      const shares = BigInt(await this.pair.balanceOf(this.addrs.safe, id))
      if (shares > 0n) {
        const [reserveX, reserveY] = await this.pair.getBin(id)
        positions.push({ id, shares, reserveX: BigInt(reserveX), reserveY: BigInt(reserveY) })
      }
    }
    return positions
  }

  /** Assert invariants used at RECONCILE state. */
  async validateInvariants(): Promise<void> {
    const helperOwner = await this.helper.OWNER()
    if (helperOwner.toLowerCase() !== this.addrs.safe.toLowerCase()) {
      throw new Error(`helper owner is ${helperOwner}, expected Safe ${this.addrs.safe}`)
    }
    const isBotOwner = await this.safe.isOwner(this.wallet.address)
    if (!isBotOwner) {
      throw new Error(`bot wallet ${this.wallet.address} is not a Safe owner`)
    }
  }
}
