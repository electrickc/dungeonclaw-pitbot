import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe("poll() case 'RECONCILE' escape", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-escape-'))
    process.env.STATE_PATH = path.join(tmpDir, 'state.json')
    process.env.POOL_ID = 'p-test'
    process.env.CONTROL_PLANE_URL = 'http://localhost/api/v1'
    process.env.CONTROL_PLANE_TOKEN = 'tkn'
    process.env.RPC_URL = 'http://localhost:8545'
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('escapes RECONCILE → PAUSED after >90s and emits timeout error event', async () => {
    const emitEvent = vi.fn(async () => undefined)

    // We resolve this when emitEvent fires so we can await the async flow
    // that main() starts without polling on timers.
    let resolveEmit!: () => void
    const emitDone = new Promise<void>((r) => { resolveEmit = r })
    const emitEventResolvable = vi.fn(async () => { resolveEmit(); return undefined })

    const oldTs = Math.floor(Date.now() / 1000) - 100

    // Mock BotStateManager to pin state=RECONCILE with a stale lastTransitionTs
    // so that boot()'s transition() call is a no-op and poll() sees RECONCILE.
    let _currentState = 'RECONCILE' as string
    let _lastTransitionTs = oldTs
    let _reason = 'stale'
    const mockTransition = vi.fn((to: string, fields: { reason?: string }) => {
      // Allow the PAUSED escape transition from the case 'RECONCILE' handler;
      // block everything else (e.g. boot()'s PENDING_SAFE_SETUP overwrite).
      if (to === 'PAUSED') {
        _currentState = 'PAUSED'
        _reason = fields.reason ?? _reason
        // Persist the update so the on-disk assertion works
        fs.writeFileSync(
          process.env.STATE_PATH!,
          JSON.stringify({ current: 'PAUSED', lastTransitionTs: Math.floor(Date.now() / 1000), reason: _reason, lastRebalanceTs: 0, currentCenter: null }),
        )
      }
      // Otherwise swallow (boot → PENDING_SAFE_SETUP, etc.)
    })

    vi.doMock('../src/state', () => ({
      BotStateManager: class {
        constructor() {}
        get current() { return _currentState }
        get snapshot() {
          return { current: _currentState, lastTransitionTs: _lastTransitionTs, reason: _reason, lastRebalanceTs: 0, currentCenter: null }
        }
        transition = mockTransition
        update = vi.fn()
      },
    }))

    vi.doMock('../src/controlPlane', () => ({
      ControlPlaneClient: class {
        constructor() {}
        async handshake() {}
        async sync() {
          return {
            status: 'operational', killSwitch: false,
            safeAddress: '0x' + '11'.repeat(20),
            helperAddress: '0x' + '22'.repeat(20),
            pairAddress: '0x' + '33'.repeat(20),
            strategy: { type: 'spot-spread', knobs: {} },
            rebalanceCooldownSeconds: 900,
            syncPollIntervalSeconds: 30,
            chainPollIntervalSeconds: 30,
            consecutiveSyncFailureThreshold: 3,
          }
        }
        emitEvent = emitEventResolvable
      },
    }))

    vi.doMock('ethers', async () => {
      const actual = await vi.importActual<typeof import('ethers')>('ethers')
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          JsonRpcProvider: class { constructor() {} },
          Contract: class {
            async tokenX() { return '0x' + '44'.repeat(20) }
            async tokenY() { return '0x' + '55'.repeat(20) }
          },
          Wallet: class {
            address = '0x' + '66'.repeat(20)
            privateKey = '0x' + '77'.repeat(32)
            static createRandom() { return new (this as never)() }
          },
        },
      }
    })

    // Importing src/index fires main() → boot() → poll().
    // With our mocked BotStateManager, state stays RECONCILE throughout boot()
    // (boot's transition call is swallowed), so poll()'s case 'RECONCILE' branch
    // fires, sees elapsed > 90s, transitions to PAUSED, and calls emitEvent.
    await import('../src/index')

    // Wait for the RECONCILE timeout emitEvent call from main's poll.
    await emitDone

    const stateOnDisk = JSON.parse(fs.readFileSync(process.env.STATE_PATH!, 'utf8'))
    expect(stateOnDisk.current).toBe('PAUSED')
    expect(stateOnDisk.reason).toMatch(/reconcile timeout/)
    expect(emitEventResolvable).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      payload: expect.objectContaining({ reason: 'reconcile timeout' }),
    }))
  })

  it('does NOT escape RECONCILE if elapsed < 90s', async () => {
    const emitEvent = vi.fn(async () => undefined)

    // We need a way to know main()'s first poll() has completed without
    // emitEvent firing (since no escape should happen). We'll resolve after
    // sync() is called (which always happens in poll() before the switch).
    let resolveSyncDone!: () => void
    const syncDone = new Promise<void>((r) => { resolveSyncDone = r })
    let syncCallCount = 0

    const recentTs = Math.floor(Date.now() / 1000) - 10
    let _currentState = 'RECONCILE' as string

    vi.doMock('../src/state', () => ({
      BotStateManager: class {
        constructor() {}
        get current() { return _currentState }
        get snapshot() {
          return { current: _currentState, lastTransitionTs: recentTs, reason: 'fresh', lastRebalanceTs: 0, currentCenter: null }
        }
        transition = vi.fn((to: string) => {
          // Only allow if it's not an overwrite we care about
          if (to === 'PAUSED') {
            _currentState = 'PAUSED'
          }
        })
        update = vi.fn()
      },
    }))

    vi.doMock('../src/controlPlane', () => ({
      ControlPlaneClient: class {
        constructor() {}
        async handshake() {}
        async sync() {
          syncCallCount++
          if (syncCallCount === 1) {
            // Resolve after this sync call returns so poll() can proceed to
            // the switch and we can assert no transition happened.
            Promise.resolve().then(resolveSyncDone)
          }
          return {
            status: 'operational', killSwitch: false,
            safeAddress: '0x' + '11'.repeat(20),
            helperAddress: '0x' + '22'.repeat(20),
            pairAddress: '0x' + '33'.repeat(20),
            strategy: { type: 'spot-spread', knobs: {} },
            rebalanceCooldownSeconds: 900,
            syncPollIntervalSeconds: 30,
            chainPollIntervalSeconds: 30,
            consecutiveSyncFailureThreshold: 3,
          }
        }
        emitEvent = emitEvent
      },
    }))

    vi.doMock('ethers', async () => {
      const actual = await vi.importActual<typeof import('ethers')>('ethers')
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          JsonRpcProvider: class { constructor() {} },
          Contract: class {
            async tokenX() { return '0x' + '44'.repeat(20) }
            async tokenY() { return '0x' + '55'.repeat(20) }
          },
          Wallet: class {
            address = '0x' + '66'.repeat(20)
            privateKey = '0x' + '77'.repeat(32)
            static createRandom() { return new (this as never)() }
          },
        },
      }
    })

    await import('../src/index')

    // Wait for the first sync() inside poll() to have been called and the
    // microtask that resolves syncDone to have run. Give a small tick.
    await syncDone
    // Yield to let the synchronous part of poll() after sync() run.
    await new Promise((r) => setTimeout(r, 50))

    // State should still be RECONCILE — no timeout escape happened.
    expect(_currentState).toBe('RECONCILE')
    expect(emitEvent).not.toHaveBeenCalled()
  })
})
