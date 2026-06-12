import fs from 'fs'
import path from 'path'

export type StateName =
  | 'BOOT'
  | 'PENDING_SAFE_SETUP'
  | 'RECONCILE'
  | 'OPERATIONAL'
  | 'PAUSED'
  | 'RETIRED'

export interface BotState {
  current: StateName
  lastTransitionTs: number
  reason: string
  lastRebalanceTs: number
  currentCenter: number | null
}

// PAUSED → PENDING_SAFE_SETUP is allowed so a container restart can recover
// without manual VM rebuild (the boot() flow re-enters PENDING_SAFE_SETUP).
// Same for OPERATIONAL → PENDING_SAFE_SETUP in case the persisted state is
// OPERATIONAL but in-memory pool/signer were lost on crash.
const VALID_TRANSITIONS: Record<StateName, StateName[]> = {
  BOOT: ['PENDING_SAFE_SETUP'],
  PENDING_SAFE_SETUP: ['RECONCILE', 'PAUSED', 'RETIRED'],
  // PENDING_SAFE_SETUP is allowed so the boot-time reset can recover from a
  // stale RECONCILE persisted in state.json after a mid-reconcile crash.
  // Without this, the bot crash-loops at startup because the persisted state
  // is RECONCILE and boot() can't legally reset it.
  RECONCILE: ['OPERATIONAL', 'PAUSED', 'RETIRED', 'PENDING_SAFE_SETUP'],
  OPERATIONAL: ['PAUSED', 'RETIRED', 'PENDING_SAFE_SETUP'],
  PAUSED: ['OPERATIONAL', 'RETIRED', 'PENDING_SAFE_SETUP'],
  RETIRED: [],
}

export class BotStateManager {
  private state: BotState

  constructor(private readonly statePath: string) {
    if (fs.existsSync(statePath)) {
      this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } else {
      this.state = {
        current: 'BOOT',
        lastTransitionTs: 0,
        reason: 'initial',
        lastRebalanceTs: 0,
        currentCenter: null,
      }
      this.persist()
    }
  }

  get current(): StateName {
    return this.state.current
  }

  get snapshot(): Readonly<BotState> {
    return { ...this.state }
  }

  transition(to: StateName, fields: Partial<BotState> & { reason?: string }): void {
    const allowed = VALID_TRANSITIONS[this.state.current]
    if (!allowed.includes(to)) {
      throw new Error(`invalid transition: ${this.state.current} -> ${to}`)
    }
    this.state = {
      ...this.state,
      ...fields,
      current: to,
      lastTransitionTs: Math.floor(Date.now() / 1000),
      reason: fields.reason ?? this.state.reason,
    }
    this.persist()
  }

  update(fields: Partial<Omit<BotState, 'current'>>): void {
    this.state = { ...this.state, ...fields }
    this.persist()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2))
  }
}
