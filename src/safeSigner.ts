import { ethers } from 'ethers'
import { withTimeout } from './util/withTimeout'

// Bound on `tx.wait()`. The Safe nonce read + getTransactionHash + signing
// + execTransaction submission run in tens of ms; the wait is the only
// part that depends on chain inclusion. 2 minutes is generous against Base's
// 2s blocks (≈60 blocks) and short enough to surface a stuck mempool / dead
// RPC before the main poll loop can be hung waiting on it indefinitely.
const TX_WAIT_TIMEOUT_MS = 120_000

/**
 * Signs a Safe transaction hash producing a 65-byte signature in the format
 * Safe.execTransaction expects: r (32) ++ s (32) ++ v (1).
 *
 * Safe v1.4.1 `checkSignatures` v-byte semantics:
 *   v = 0       → ERC-1271 contract signature
 *   v = 1       → pre-validated owner (msg.sender or approvedHashes)
 *   v = 27/28   → standard secp256k1 ecrecover over the raw 32-byte hash
 *   v = 31/32   → ecrecover over EIP-191-prefixed hash (`"\x19Ethereum Signed Message:\n32" || h`)
 *
 * We sign the raw safeTxHash directly (no EIP-191 prefix), so v MUST stay
 * 27/28. Bumping by +4 (to 31/32) makes Safe re-prefix when recovering,
 * which yields a different signer address → GS026 "Invalid owner provided".
 */
export async function computeSafeSignature(
  wallet: ethers.Wallet,
  safeTxHash: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signing = (wallet as any).signingKey ?? new ethers.SigningKey(wallet.privateKey)
  const sig = signing.sign(safeTxHash)
  const r = sig.r.slice(2)
  const s = sig.s.slice(2)
  // sig.v is already 27 or 28 from ethers SigningKey — use as-is.
  return `0x${r}${s}${sig.v.toString(16).padStart(2, '0')}`
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
    // Without this timeout an unresponsive RPC or a tx stuck in mempool
    // (e.g. nonce gap, dropped from gossip) silently hangs the bot's main
    // poll loop indefinitely. The receive of a RPCTimeoutError bubbles up
    // to the caller which already handles it by transitioning to PAUSED.
    const receipt = await withTimeout<ethers.TransactionReceipt | null>(
      tx.wait(),
      TX_WAIT_TIMEOUT_MS,
      'execTransaction.wait',
    )
    if (!receipt) throw new Error('no receipt')
    return receipt
  }
}
