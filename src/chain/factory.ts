import type { ChainAdapter, ChainAdapterConfig } from './types'
import { EvmAdapter } from './evm/EvmAdapter'
import { SolanaAdapter } from './solana/SolanaAdapter'

/**
 * Pick the right adapter implementation based on `cfg.kind`. Called exactly
 * once at boot from `src/index.ts` after `boot()` decides the chain from the
 * `CHAIN_KIND` env (defaults to 'evm' for Base back-compat).
 *
 * Per-chain expected chainId is baked in here so the bot can assert the RPC
 * is on the expected network during reconcile.
 */
export function createChainAdapter(cfg: ChainAdapterConfig): ChainAdapter {
  switch (cfg.kind) {
    case 'evm':
      // Base mainnet. Hard-coded for now — multi-EVM-chain support is a
      // separate config knob if/when needed.
      return new EvmAdapter(cfg, 8453)
    case 'solana':
      return new SolanaAdapter(cfg)
    default: {
      const exhaust: never = cfg.kind
      throw new Error(`unknown chain kind: ${exhaust}`)
    }
  }
}
