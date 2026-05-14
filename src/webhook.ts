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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Pitbot-Signature': sig,
    'X-Pitbot-Timestamp': String(event.ts),
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
    const res = await fetch(config.adminWebhookUrl, {
      method: 'POST',
      headers,
      body,
    })
    if (!res.ok) {
      console.error(`[webhook] non-2xx: ${res.status} ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    // Webhook failures must not crash the bot. Log and continue.
    console.error(`[webhook] failed:`, err instanceof Error ? err.message : err)
  }
}
