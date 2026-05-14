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
  try {
    const res = await fetch(config.adminWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pitbot-Signature': sig,
        'X-Pitbot-Timestamp': String(event.ts),
      },
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
