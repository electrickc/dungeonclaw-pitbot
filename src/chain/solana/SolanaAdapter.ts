import type {
  ChainAdapter,
  ChainAdapterConfig,
  PoolAddresses,
  PoolSnapshot,
  BinPosition,
  MintPlan,
  TxReceipt,
} from '../types'

/**
 * Solana chain adapter — Phase B target (Meteora DLMM + Squads V4 multisig).
 *
 * THIS IS A STUB. Every method throws so the bot crashes loudly if the
 * factory misroutes a Solana config before the real implementation lands.
 * Wiring order to fill it in:
 *
 *   1. Install @meteora-ag/dlmm + @sqds/multisig
 *   2. Replace the constructor with: load Squads multisig client, load
 *      Meteora pool client, derive bot Keypair from cfg.botPrivateKey
 *      (Ed25519 32 bytes hex).
 *   3. snapshot() → meteora.pool.refetchPositionsForAccount(custody) +
 *      meteora.pool.refetchActiveBin() + token program balances of custody.
 *   4. safeBinPositions() → walk position accounts, filter by custody owner.
 *   5. mint()/burn() → build instruction sequence (addLiquidityByStrategy /
 *      removeLiquidityByRange) wrapped as a Squads proposal, sign + execute.
 *   6. validateInvariants() → check Squads members include bot pubkey,
 *      check Meteora authority delegate is configured for our helper PDA.
 *   7. chainId is the cluster moniker ('solana-mainnet').
 */
export class SolanaAdapter implements ChainAdapter {
  readonly kind = 'solana' as const
  readonly chainId: string
  readonly addrs: PoolAddresses
  readonly botAddress: string

  constructor(cfg: ChainAdapterConfig) {
    if (cfg.kind !== 'solana') {
      throw new Error(`SolanaAdapter constructed with kind=${cfg.kind}`)
    }
    this.chainId = 'solana-mainnet'
    this.addrs = cfg.addrs
    // TODO: derive Pubkey from Ed25519 private key
    this.botAddress = ''
    throw new Error('SolanaAdapter not yet implemented — Phase B')
  }

  snapshot(): Promise<PoolSnapshot> {
    throw new Error('SolanaAdapter.snapshot not implemented')
  }
  safeBinPositions(_activeBin: number, _windowSize: number): Promise<BinPosition[]> {
    throw new Error('SolanaAdapter.safeBinPositions not implemented')
  }
  getBotBalance(): Promise<bigint> {
    throw new Error('SolanaAdapter.getBotBalance not implemented')
  }
  validateInvariants(): Promise<void> {
    throw new Error('SolanaAdapter.validateInvariants not implemented')
  }
  getChainId(): Promise<string> {
    return Promise.resolve(this.chainId)
  }
  mint(_plan: MintPlan): Promise<TxReceipt> {
    throw new Error('SolanaAdapter.mint not implemented')
  }
  burn(_binIds: number[], _shares: bigint[]): Promise<TxReceipt> {
    throw new Error('SolanaAdapter.burn not implemented')
  }
}
