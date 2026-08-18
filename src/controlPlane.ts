export interface ControlPlaneConfig {
  baseUrl: string
  token: string
  poolId: string
}

export interface SyncResponse {
  status: 'pending_safe_setup' | 'operational' | 'paused' | 'retired'
  safeAddress: string | null
  helperAddress: string | null
  pairAddress: string | null
  strategy: {
    type: 'spot-spread' | 'spot-wide' | 'wall'
    knobs: Record<string, any>
  } | null
  rebalanceCooldownSeconds: number
  syncPollIntervalSeconds: number
  chainPollIntervalSeconds: number
  killSwitch: boolean
  consecutiveSyncFailureThreshold: number
}

export interface Event {
  ts: number
  type: 'rebalance' | 'place' | 'withdraw' | 'error' | 'state_transition' | 'gas_returned'
  payload: Record<string, any>
}

export class ControlPlaneClient {
  constructor(private readonly cfg: ControlPlaneConfig) {}

  async handshake(botAddress: string, version = '1.0.0'): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}/pools/${this.cfg.poolId}/handshake`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-control-token': this.cfg.token,
      },
      body: JSON.stringify({ botAddress, version }),
    })
    if (!res.ok) throw new Error(`handshake failed: ${res.status}`)
  }

  async sync(): Promise<SyncResponse> {
    const res = await fetch(`${this.cfg.baseUrl}/pools/${this.cfg.poolId}/sync`, {
      headers: { 'x-control-token': this.cfg.token },
    })
    if (!res.ok) throw new Error(`sync failed: ${res.status}`)
    return res.json() as Promise<SyncResponse>
  }

  async emitEvent(event: Event): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}/pools/${this.cfg.poolId}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-control-token': this.cfg.token,
      },
      body: JSON.stringify(event),
    })
    if (!res.ok) throw new Error(`event emit failed: ${res.status}`)
  }
}
