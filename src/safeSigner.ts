import { ethers } from 'ethers'

/**
 * Signs a Safe transaction hash producing a 65-byte signature in the format
 * Safe.execTransaction expects.
 *
 * Safe signature format: r (32) ++ s (32) ++ v (1).
 * EIP-191 prefix bumps v by +4 — Safe accepts both.
 */
export async function computeSafeSignature(
  wallet: ethers.Wallet,
  safeTxHash: string,
): Promise<string> {
  // ethers `signMessage` hashes with the EIP-191 prefix; safeTxHash is already a 32-byte
  // hash so we sign the digest directly using signingKey.
  const signing = (wallet as any).signingKey ?? new ethers.SigningKey(wallet.privateKey)
  const sig = signing.sign(safeTxHash)
  // Adjust v to 31/32 (Safe's pre-validated marker) so the bot's pre-signed sig is accepted.
  const adjustedV = sig.v + 4
  const r = sig.r.slice(2)
  const s = sig.s.slice(2)
  return `0x${r}${s}${adjustedV.toString(16).padStart(2, '0')}`
}

export interface SafeTxParams {
  to: string
  value: bigint
  data: string
  operation: number // 0 = CALL
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: string
  refundReceiver: string
}

export class SafeSigner {
  constructor(
    private readonly safe: ethers.Contract,
    private readonly wallet: ethers.Wallet,
  ) {}

  /** Build a Safe tx, sign with bot key, submit via execTransaction. */
  async execTransaction(params: SafeTxParams): Promise<ethers.TransactionReceipt> {
    const nonce = await this.safe.nonce()
    const safeTxHash: string = await this.safe.getTransactionHash(
      params.to,
      params.value,
      params.data,
      params.operation,
      params.safeTxGas,
      params.baseGas,
      params.gasPrice,
      params.gasToken,
      params.refundReceiver,
      nonce,
    )
    const sig = await computeSafeSignature(this.wallet, safeTxHash)
    const tx = await this.safe.execTransaction(
      params.to,
      params.value,
      params.data,
      params.operation,
      params.safeTxGas,
      params.baseGas,
      params.gasPrice,
      params.gasToken,
      params.refundReceiver,
      sig,
    )
    const receipt = await tx.wait()
    if (!receipt) throw new Error('no receipt')
    return receipt
  }
}
