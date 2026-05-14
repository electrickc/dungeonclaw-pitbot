import * as fs from 'fs'
import * as dotenv from 'dotenv'

dotenv.config()

function loadSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`]
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim()
  }
  const direct = process.env[name]
  if (direct) return direct.trim()
  throw new Error(`Missing secret: ${name} (set ${name} or ${name}_FILE)`)
}

function loadSecretOpt(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`]
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim()
  }
  const direct = process.env[name]
  return direct ? direct.trim() : undefined
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

function num(name: string, fallback?: number): number {
  const v = process.env[name]
  if (!v) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing env: ${name}`)
  }
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Env ${name} is not a number: ${v}`)
  return n
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

export const config = {
  privateKey: loadSecret('BOT_PRIVATE_KEY'),
  drpcKey: loadSecret('DRPC_BASE_KEY'),
  adminHmac: loadSecret('ADMIN_WEBHOOK_HMAC'),
  // Optional: only needed if admin app is behind Vercel Deployment Protection.
  vercelBypassSecret: loadSecretOpt('VERCEL_BYPASS_SECRET'),

  adminWebhookUrl: req('ADMIN_WEBHOOK_URL'),

  poolAddress: req('POOL_ADDRESS'),
  dclawAddress: req('DCLAW_ADDRESS'),
  wethAddress: req('WETH_ADDRESS'),
  binStep: num('BIN_STEP', 240),

  totalWethBudget: req('TOTAL_WETH_BUDGET'),
  wallBinCount: num('WALL_BIN_COUNT', 7),
  binOffsetFromActive: num('BIN_OFFSET_FROM_ACTIVE', 3),
  skew: (process.env.SKEW || 'exponential') as 'linear' | 'exponential',
  rebalanceBinsThreshold: num('REBALANCE_BINS_THRESHOLD', 2),
  rebalanceCooldownSeconds: num('REBALANCE_COOLDOWN_SECONDS', 60),
  pollIntervalSeconds: num('POLL_INTERVAL_SECONDS', 15),

  // DRY_RUN defaults to FALSE (live mode). Opt INTO dry-run by setting
  // DRY_RUN=1 explicitly. The previous default-to-true behavior was safer
  // for first-time setup but kept getting stuck when env injection bugs in
  // the deployment platform left the bot in simulation mode indefinitely.
  dryRun: bool('DRY_RUN', false),
  kill: bool('KILL', false),
  maxGasGwei: num('MAX_GAS_GWEI', 2),

  logLevel: process.env.LOG_LEVEL || 'info',
} as const

export function rpcUrl(): string {
  return `https://lb.drpc.live/base/${config.drpcKey}`
}
