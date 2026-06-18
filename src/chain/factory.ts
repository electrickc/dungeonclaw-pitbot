import type { ChainAdapter, ChainAdapterConfig } from './types'
import { EvmAdapter } from './evm/EvmAdapter'

/**
 * Pick the right adapter implementation based on `cfg.kind`. Called exactly
 * once at boot from `src/index.ts` after `boot()` decides the chain from the
 * `CHAIN_KIND` env (defaults to 'evm' for Base back-compat).
 *
 * Per-chain expected chainId is baked in here so the bot can assert the RPC
 * is on the expected network during reconcile.
 *
 * The Solana adapter is DYNAMICALLY imported because the underlying Meteora
 * SDK has a known ESM/CJS interop quirk (it imports Anchor's `bytes` utils
 * via directory imports that vitest's ESM loader rejects). Loading it only
 * when `cfg.kind === 'solana'` keeps EVM-only test paths clean.
 */
export async function createChainAdapter(cfg: ChainAdapterConfig): Promise<ChainAdapter> {
  switch (cfg.kind) {
    case 'evm':
      // Base mainnet. Hard-coded for now — multi-EVM-chain support is a
      // separate config knob if/when needed.
      return new EvmAdapter(cfg, 8453)
    case 'solana': {
      const { SolanaAdapter } = await import('./solana/SolanaAdapter')
      return new SolanaAdapter(cfg)
    }
    default: {
      const exhaust: never = cfg.kind
      throw new Error(`unknown chain kind: ${exhaust}`)
    }
  }
}
