import * as fs from 'fs'

function loadSecret(name: string, required: boolean): string | undefined {
  const filePath = process.env[`${name}_FILE`]
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim()
  }
  const direct = process.env[name]
  if (direct) return direct.trim()
  if (required) throw new Error(`Missing secret: ${name} (set ${name} or ${name}_FILE)`)
  return undefined
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

export type ChainKind = 'evm' | 'solana'

export interface BotConfig {
  poolId: string
  controlPlaneUrl: string
  controlPlaneToken: string
  rpcUrl: string
  statePath: string
  // Which chain this bot is configured for. Defaults to 'evm' so existing
  // Base bots running v0.1.19 keep working without a compose YAML update.
  chainKind: ChainKind
  // Expected EVM chainId, asserted against the live RPC at reconcile. Comes
  // from the CHAIN_ID env (set by the control plane's provision compose).
  // Defaults to 8453 (Base) so pre-multichain bots keep working unchanged.
  expectedChainId: number
}

export function loadConfig(): BotConfig {
  const rawChain = (process.env.CHAIN_KIND ?? 'evm').toLowerCase()
  if (rawChain !== 'evm' && rawChain !== 'solana') {
    throw new Error(`CHAIN_KIND must be 'evm' or 'solana', got '${rawChain}'`)
  }
  // CHAIN_ID is optional for back-compat (pre-multichain compose YAMLs omit it);
  // default to Base. When present it must be a positive integer.
  const rawChainId = process.env.CHAIN_ID
  let expectedChainId = 8453
  if (rawChainId != null && rawChainId.trim() !== '') {
    const parsed = Number(rawChainId)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`CHAIN_ID must be a positive integer, got '${rawChainId}'`)
    }
    expectedChainId = parsed
  }
  return {
    poolId: req('POOL_ID'),
    controlPlaneUrl: req('CONTROL_PLANE_URL'),
    controlPlaneToken: loadSecret('CONTROL_PLANE_TOKEN', true)!,
    rpcUrl: req('RPC_URL'),
    statePath: process.env.STATE_PATH ?? '/data/state.json',
    chainKind: rawChain,
    expectedChainId,
  }
}
