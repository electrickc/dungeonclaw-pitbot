import { ethers } from 'ethers'
import type {
  ChainAdapter,
  ChainAdapterConfig,
  PoolAddresses,
  PoolSnapshot,
  BinPosition,
  MintPlan,
  TxReceipt,
} from '../types'
import { HELPER_ABI } from '../../abi'
import { Pool } from '../../pool'
import { SafeSigner } from '../../safeSigner'

const helperIface = new ethers.Interface(HELPER_ABI)

/**
 * EVM (Base) chain adapter. Wraps the existing `Pool` + `SafeSigner` + helper
 * encoding behind the chain-agnostic `ChainAdapter` interface.
 *
 * This is a thin pass-through: the existing classes already had the right
 * shape for what the bot's strategy/trigger expect — the wrapper just bridges
 * naming (`safe` → `custody`) and converts ethers receipts into the simpler
 * `TxReceipt` shape so the strategy layer doesn't depend on ethers.
 */
export class EvmAdapter implements ChainAdapter {
  readonly kind = 'evm' as const
  readonly chainId: number
  readonly addrs: PoolAddresses
  readonly botAddress: string

  private readonly pool: Pool
  private readonly signer: SafeSigner

  constructor(cfg: ChainAdapterConfig, chainId: number) {
    if (cfg.kind !== 'evm') {
      throw new Error(`EvmAdapter constructed with kind=${cfg.kind}`)
    }
    this.chainId = chainId
    this.addrs = cfg.addrs

    // Pool's `addrs` field uses `safe` historically — translate from the
    // chain-agnostic `custody` name. New code should reference `addrs` on
    // the adapter (chain-agnostic), not the inner Pool's `addrs.safe`.
    this.pool = new Pool(cfg.rpcUrl, cfg.botPrivateKey, {
      pair: cfg.addrs.pair,
      helper: cfg.addrs.helper,
      safe: cfg.addrs.custody,
      tokenX: cfg.addrs.tokenX,
      tokenY: cfg.addrs.tokenY,
    })
    this.signer = new SafeSigner(this.pool.safe, this.pool.wallet)
    this.botAddress = this.pool.wallet.address
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  snapshot(): Promise<PoolSnapshot> {
    return this.pool.snapshot()
  }

  safeBinPositions(activeBin: number, windowSize: number): Promise<BinPosition[]> {
    return this.pool.safeBinPositions(activeBin, windowSize)
  }

  async getBotBalance(): Promise<bigint> {
    return this.pool.provider.getBalance(this.botAddress)
  }

  validateInvariants(): Promise<void> {
    return this.pool.validateInvariants()
  }

  async getChainId(): Promise<number> {
    const network = await this.pool.provider.getNetwork()
    return Number(network.chainId)
  }

  // ─── Writes ──────────────────────────────────────────────────────────

  async mint(plan: MintPlan): Promise<TxReceipt> {
    const data = helperIface.encodeFunctionData('mintAtomic', [
      plan.binIds,
      plan.distributionX,
      plan.distributionY,
      plan.amountX,
      plan.amountY,
    ])
    const receipt = await this.signer.execTransaction({
      to: this.addrs.helper,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    })
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status === 1 ? 'success' : 'reverted',
    }
  }

  async burn(binIds: number[], shares: bigint[]): Promise<TxReceipt> {
    const data = helperIface.encodeFunctionData('burnAtomic', [binIds, shares])
    const receipt = await this.signer.execTransaction({
      to: this.addrs.helper,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    })
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status === 1 ? 'success' : 'reverted',
    }
  }
}
