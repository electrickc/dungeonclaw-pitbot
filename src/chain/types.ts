/**
 * Chain-agnostic types consumed by the strategy, trigger, and state-machine
 * layers. Adapter implementations (`./evm`, future `./solana`) translate
 * between these shapes and the chain's native primitives.
 *
 * Everything here is expressible across both an EVM `address` (20 bytes) and
 * a Solana `Pubkey` (32 bytes) using the universal `string` type — the
 * adapter is responsible for parsing/formatting to its native form.
 */

export type ChainKind = 'evm' | 'solana'

/**
 * Addresses passed across the adapter boundary. The strategy/trigger never
 * sees these — they're stored once during construction and referenced inside
 * the adapter only. The control plane sends them as opaque strings; the
 * adapter validates shape (EIP-55 vs base58) during its constructor.
 */
export interface PoolAddresses {
  pair: string       // Trader Joe LB v2 pair on EVM | Meteora DLMM pool on Solana
  helper: string     // PitBotHelper.sol on EVM | janus_helper Anchor program on Solana
  custody: string    // Gnosis Safe on EVM | Squads V4 multisig on Solana
  tokenX: string
  tokenY: string
}

/** Live snapshot read off the pair contract. */
export interface PoolSnapshot {
  activeBin: number
  binStep: number
  /** Custody account's idle balance of tokenX (raw smallest unit). */
  safeXBalance: bigint
  /** Custody account's idle balance of tokenY (raw smallest unit). */
  safeYBalance: bigint
}

/** A single bin position held by the custody account. */
export interface BinPosition {
  id: number
  shares: bigint
  reserveX: bigint
  reserveY: bigint
}

/**
 * Mint plan emitted by a strategy. Stays chain-agnostic — the adapter
 * encodes this into either a Safe execTransaction call or a Squads multisig
 * proposal as appropriate.
 */
export interface MintPlan {
  binIds: number[]
  distributionX: bigint[]  // 1e18-scaled per-bin fractions of amountX
  distributionY: bigint[]
  amountX: bigint
  amountY: bigint
}

/** Chain-agnostic tx receipt — the strategy doesn't care about block details. */
export interface TxReceipt {
  hash: string
  blockNumber?: number
  status: 'success' | 'reverted'
}

/**
 * The contract every chain adapter must satisfy. Implementations live in
 * `./evm/EvmAdapter.ts` and the future `./solana/SolanaAdapter.ts`. The
 * adapter is created once at boot from a `ChainConfig` (RPC URL + private
 * key + pool addresses) and held for the lifetime of the bot process.
 */
export interface ChainAdapter {
  /** Identity used by the bot to fork chain-specific behavior in tight spots. */
  readonly kind: ChainKind

  /** Native chain id (EVM uint256 → number; Solana cluster name). */
  readonly chainId: number | string

  /** Pool / Safe / helper / token addresses. Validated by the adapter at construct. */
  readonly addrs: PoolAddresses

  /** Bot signer's public address (EOA on EVM, Pubkey on Solana). */
  readonly botAddress: string

  // ─── Reads ──────────────────────────────────────────────────────────

  /** Snapshot the pool: active bin, bin step, custody balances. */
  snapshot(): Promise<PoolSnapshot>

  /** Scan a window around activeBin and return only bins the custody account holds. */
  safeBinPositions(activeBin: number, windowSize: number): Promise<BinPosition[]>

  /** Native-gas-token balance of the bot signer (wei on EVM, lamports on Solana). */
  getBotBalance(): Promise<bigint>

  /** Submit any missing Safe→helper approvals (tokenX, tokenY, pair ERC-1155). No-op if already set. */
  ensureApprovals(): Promise<void>

  /** Pre-flight checks that abort reconcile early on misconfig. */
  validateInvariants(): Promise<void>

  /** Get the chain's notion of "current native chainId" for assertion. */
  getChainId(): Promise<number | string>

  // ─── Writes ──────────────────────────────────────────────────────────

  /** Atomic mint via the helper. Submits a custody-signed tx and waits. */
  mint(plan: MintPlan): Promise<TxReceipt>

  /** Atomic burn via the helper. Submits a custody-signed tx and waits. */
  burn(binIds: number[], shares: bigint[]): Promise<TxReceipt>
}

/** Config passed to the adapter factory at boot. */
export interface ChainAdapterConfig {
  kind: ChainKind
  rpcUrl: string
  botPrivateKey: string
  addrs: PoolAddresses
}

/**
 * Factory that picks the right adapter based on `cfg.kind`. The bot calls
 * this exactly once at boot. New chain support means adding a case here
 * and an implementation under `./<kind>/`.
 */
export type ChainAdapterFactory = (cfg: ChainAdapterConfig) => ChainAdapter
