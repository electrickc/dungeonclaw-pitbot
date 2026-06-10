import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { computeSafeSignature } from '../src/safeSigner'

describe('computeSafeSignature', () => {
  it('produces a 65-byte signature in Safe pre-validated format', async () => {
    const wallet = ethers.Wallet.createRandom()
    const safeTxHash = ethers.keccak256(ethers.toUtf8Bytes('test'))
    const sig = await computeSafeSignature(wallet, safeTxHash)
    // 65 bytes hex = 132 chars + '0x' prefix
    expect(sig.length).toBe(132)
    // The last byte should be 0x1f, 0x20 or one of the EIP-191 v values
    const v = parseInt(sig.slice(-2), 16)
    expect([27, 28, 31, 32]).toContain(v)
  })
})
