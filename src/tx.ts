import { ethers } from 'ethers'
import { HELPER_ABI } from './abi'
import { Pool } from './pool'
import { SafeSigner } from './safeSigner'
import type { MintPlan } from './strategy/index'

const helperIface = new ethers.Interface(HELPER_ABI)

export class TxLayer {
  constructor(
    private readonly pool: Pool,
    private readonly signer: SafeSigner,
  ) {}

  /** Send Safe tx that calls helper.mintAtomic atomically. */
  async mint(plan: MintPlan): Promise<ethers.TransactionReceipt> {
    const data = helperIface.encodeFunctionData('mintAtomic', [
      plan.binIds,
      plan.distributionX,
      plan.distributionY,
      plan.amountX,
      plan.amountY,
    ])
    return this.signer.execTransaction({
      to: this.pool.addrs.helper,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    })
  }

  async burn(binIds: number[], shares: bigint[]): Promise<ethers.TransactionReceipt> {
    const data = helperIface.encodeFunctionData('burnAtomic', [binIds, shares])
    return this.signer.execTransaction({
      to: this.pool.addrs.helper,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    })
  }
}
