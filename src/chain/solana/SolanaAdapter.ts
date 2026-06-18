import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'
import type {
  ChainAdapter,
  ChainAdapterConfig,
  PoolAddresses,
  PoolSnapshot,
  BinPosition,
  MintPlan,
  TxReceipt,
} from '../types'

// SPL Token program — used for SPL token balanceOf reads on the custody.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

/**
 * Solana chain adapter — Phase B implementation.
 *
 * Reads + balance work end to end against Meteora DLMM via the official SDK.
 * Mint / burn are stubbed pending the Squads multisig wiring (Phase C):
 * the adapter knows how to BUILD the addLiquidityByStrategy / removeLiquidity
 * transactions, but the custody account is a Squads multisig (not a single
 * EOA), so the bot can't sign-and-send directly — it must propose the tx
 * through Squads and have the user sign the second leg.
 *
 * Token discovery: the SDK exposes `dlmm.tokenX.mint` and `dlmm.tokenY.mint`
 * once the pool is loaded, so the constructor's addrs.tokenX/tokenY are
 * cross-checked but the loaded pool is authoritative.
 */
export class SolanaAdapter implements ChainAdapter {
  readonly kind = 'solana' as const
  readonly chainId: string = 'solana-mainnet'
  readonly addrs: PoolAddresses
  readonly botAddress: string

  private readonly connection: Connection
  private readonly botKeypair: Keypair
  private dlmm: DLMM | null = null
  private cachedBinStep: number | null = null
  private cachedTokenXProgram: PublicKey | null = null
  private cachedTokenYProgram: PublicKey | null = null

  constructor(cfg: ChainAdapterConfig) {
    if (cfg.kind !== 'solana') {
      throw new Error(`SolanaAdapter constructed with kind=${cfg.kind}`)
    }
    this.addrs = cfg.addrs
    this.connection = new Connection(cfg.rpcUrl, 'confirmed')

    // The 32-byte secp256k1 private key from ensureBotWallet is reused here
    // as an ed25519 seed. Both curves use 32-byte seeds, so the same on-disk
    // wallet.key blob can drive either chain — the adapter picks the right
    // curve at construct. For new Solana pools, ensureBotWallet still emits
    // 32 random bytes via ethers.Wallet.createRandom().privateKey; only the
    // INTERPRETATION differs by chain.
    const hex = cfg.botPrivateKey.startsWith('0x') ? cfg.botPrivateKey.slice(2) : cfg.botPrivateKey
    const seed = Buffer.from(hex, 'hex')
    if (seed.length !== 32) {
      throw new Error(`SolanaAdapter expected 32-byte hex private key, got ${seed.length} bytes`)
    }
    this.botKeypair = Keypair.fromSeed(seed)
    this.botAddress = this.botKeypair.publicKey.toBase58()
  }

  // Lazy DLMM load — held across the adapter's lifetime, refreshed on
  // snapshot() since Meteora caches state internally.
  private async getDlmm(): Promise<DLMM> {
    if (this.dlmm) return this.dlmm
    this.dlmm = await DLMM.create(this.connection, new PublicKey(this.addrs.pair))
    return this.dlmm
  }

  async getChainId(): Promise<string> {
    // Solana doesn't have a single chainId int; we use the RPC's genesis
    // hash for assertion against an expected mainnet value if needed. For
    // now we trust the env's RPC and return our static cluster moniker.
    return this.chainId
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  async snapshot(): Promise<PoolSnapshot> {
    const dlmm = await this.getDlmm()
    await dlmm.refetchStates()
    const [activeBin, balances] = await Promise.all([
      dlmm.getActiveBin(),
      this.fetchCustodyBalances(),
    ])
    // binStep is fixed at pool creation; cache after first read.
    if (this.cachedBinStep == null) {
      this.cachedBinStep = dlmm.lbPair.binStep
    }
    return {
      activeBin: activeBin.binId,
      binStep: this.cachedBinStep,
      safeXBalance: balances.x,
      safeYBalance: balances.y,
    }
  }

  /** Load SPL token balances for tokenX and tokenY held by the custody account. */
  private async fetchCustodyBalances(): Promise<{ x: bigint; y: bigint }> {
    const dlmm = await this.getDlmm()
    const custody = new PublicKey(this.addrs.custody)
    // Pick the right token program (SPL vs Token-2022) per mint.
    if (!this.cachedTokenXProgram || !this.cachedTokenYProgram) {
      const [xInfo, yInfo] = await Promise.all([
        this.connection.getAccountInfo(dlmm.tokenX.publicKey),
        this.connection.getAccountInfo(dlmm.tokenY.publicKey),
      ])
      this.cachedTokenXProgram = xInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      this.cachedTokenYProgram = yInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    }
    // Derive the associated token accounts.
    const [ataX, ataY] = [
      this.deriveAta(custody, dlmm.tokenX.publicKey, this.cachedTokenXProgram),
      this.deriveAta(custody, dlmm.tokenY.publicKey, this.cachedTokenYProgram),
    ]
    const [balX, balY] = await Promise.all([
      this.readTokenBalance(ataX),
      this.readTokenBalance(ataY),
    ])
    return { x: balX, y: balY }
  }

  private deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return ata
  }

  private async readTokenBalance(ata: PublicKey): Promise<bigint> {
    try {
      const acct = await this.connection.getTokenAccountBalance(ata, 'confirmed')
      return BigInt(acct.value.amount)
    } catch {
      // Account doesn't exist (zero balance + never created).
      return 0n
    }
  }

  async safeBinPositions(activeBin: number, windowSize: number): Promise<BinPosition[]> {
    const dlmm = await this.getDlmm()
    const custody = new PublicKey(this.addrs.custody)
    const positions = await dlmm.getPositionsByUserAndLbPair(custody)
    // Meteora stores positions as ranges (lowerBinId..upperBinId); each
    // position has a binData array with per-bin liquidity. Flatten into
    // the bot's per-bin BinPosition shape.
    const out: BinPosition[] = []
    const lowBound = activeBin - windowSize
    const highBound = activeBin + windowSize
    for (const pos of positions.userPositions) {
      for (const bd of pos.positionData.positionBinData) {
        if (bd.binId < lowBound || bd.binId > highBound) continue
        // positionLiquidity = shares in Meteora's nomenclature.
        const shares = BigInt(bd.positionLiquidity ?? '0')
        if (shares === 0n) continue
        const reserveX = BigInt(bd.binXAmount ?? '0')
        const reserveY = BigInt(bd.binYAmount ?? '0')
        out.push({ id: bd.binId, shares, reserveX, reserveY })
      }
    }
    return out
  }

  async getBotBalance(): Promise<bigint> {
    const lamports = await this.connection.getBalance(this.botKeypair.publicKey, 'confirmed')
    return BigInt(lamports)
  }

  async validateInvariants(): Promise<void> {
    // Phase B: pool + custody existence. Squads multisig owner check + Meteora
    // helper PDA approval check land in Phase C once the Anchor program ships.
    const dlmm = await this.getDlmm()
    if (!dlmm.lbPair) {
      throw new Error(`Meteora pool not found at ${this.addrs.pair}`)
    }
    const custodyInfo = await this.connection.getAccountInfo(new PublicKey(this.addrs.custody))
    if (!custodyInfo) {
      throw new Error(`Custody account not found at ${this.addrs.custody}`)
    }
    // TODO Phase C: assert Squads multisig contains botAddress as a member,
    // assert helper-PDA is delegated as Meteora position operator.
  }

  // ─── Writes — Phase C stubs ─────────────────────────────────────────

  async mint(plan: MintPlan): Promise<TxReceipt> {
    // Plan exists; building the addLiquidityByStrategy tx via Meteora SDK is
    // straightforward. The blocker is custody-side signing: position
    // ownership lives with the Squads multisig, so the bot can't sign-and-
    // send. Phase C wires a SquadsSigner that proposes + executes.
    void plan
    throw new Error('SolanaAdapter.mint requires Squads multisig signer — Phase C')
  }

  async burn(binIds: number[], shares: bigint[]): Promise<TxReceipt> {
    void binIds; void shares
    throw new Error('SolanaAdapter.burn requires Squads multisig signer — Phase C')
  }
}
