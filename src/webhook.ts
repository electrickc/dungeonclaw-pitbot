import * as crypto from 'crypto'
import { config } from './config'

export type EventType =
  | 'boot'
  | 'tick'
  | 'rebalance_placed'
  | 'rebalance_skipped'
  | 'bin_filled'
  | 'withdrawal'
  | 'error'

export interface PitbotEvent {
  type: EventType
  ts: number
  txHash?: string
  activeBin?: number
  wallCenterBin?: number | null
  wethDelta?: string // wei, signed string
  dclawDelta?: string // wei, signed string
  raw?: Record<string, unknown>
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

export async function emit(event: PitbotEvent): Promise<void> {
  const body = JSON.stringify(event)
  const sig = sign(body, config.adminHmac)
  // Use wall-clock for the transport timestamp (not event.ts which is chain
  // block time and can lag wall-clock 5-15s on Base). The admin's 5-min
  // replay-protection window compares this to its own wall-clock, so we'd
  // get spurious "stale timestamp" 401s when chain time drifts.
  const wallClockTs = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Pitbot-Signature': sig,
    'X-Pitbot-Timestamp': String(wallClockTs),
  }
  // If the admin app is behind Vercel's Deployment Protection, this header
  // tells Vercel to skip its auth wall and let our request reach Next.js.
  // The secret is generated in Vercel → Project Settings → Deployment
  // Protection → "Protection Bypass for Automation". Without this header
  // every POST gets a Vercel 401 before our route ever runs.
  if (config.vercelBypassSecret) {
    headers['x-vercel-protection-bypass'] = config.vercelBypassSecret
    // This tells Vercel to also set a session cookie so subsequent same-IP
    // requests don't re-evaluate the bypass. Optional but cheap.
    headers['x-vercel-set-bypass-cookie'] = 'samesitenone'
  }
  try {
    // 5s timeout: Vercel cold starts + Supabase round-trip + Cloudflare hop
    // should fit comfortably. Without this, a single hung TLS handshake will
    // freeze the bot's tick loop indefinitely. AbortSignal.timeout() is
    // standard since Node 17.3 / 18.
    const res = await fetch(config.adminWebhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.error(`[webhook] non-2xx: ${res.status} ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    // Webhook failures must not crash the bot. Log and continue.
    console.error(`[webhook] failed:`, err instanceof Error ? err.message : err)
  }
}
