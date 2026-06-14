import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('reconcile() error paths', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-err-'))
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

  it('throwing RPC inside reconcile → state=PAUSED + cp.emitEvent error called', async () => {
    // Resolve when emitEvent is called so we can await reconcile completion
    // without depending on main()'s internal async scheduling.
    let resolveEmit!: () => void
    const emitDone = new Promise<void>((r) => { resolveEmit = r })
    const emitEvent = vi.fn(async () => { resolveEmit(); return undefined })

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
        emitEvent = emitEvent
      },
    }))

    vi.doMock('../src/pool', () => ({
      Pool: class {
        async validateInvariants() { throw new Error('boom') }
        async snapshot() { return { activeBin: 8388608, binStep: 10, safeXBalance: 0n, safeYBalance: 0n } }
        async safeBinPositions() { return [] }
      },
    }))

    vi.doMock('../src/safeSigner', () => ({ SafeSigner: class { constructor() {} } }))
    vi.doMock('../src/tx', () => ({ TxLayer: class { constructor() {} } }))
    vi.doMock('../src/strategy', () => ({
      buildStrategy: () => ({ id: 'spot-spread', plan: () => null as never }),
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

    // Importing src/index fires main() which calls boot() → poll() → reconcile().
    // validateInvariants() throws 'boom', so reconcile's outer catch runs,
    // transitions to PAUSED, and calls emitEvent. We verify via emitDone.
    const indexMod = await import('../src/index')
    const reconcile = (indexMod as unknown as { reconcile: (sync: unknown) => Promise<void> }).reconcile
    expect(typeof reconcile).toBe('function')

    // Wait for main()'s reconcile error-path to complete (emitEvent call)
    await emitDone

    const stateOnDisk = JSON.parse(fs.readFileSync(process.env.STATE_PATH!, 'utf8'))
    expect(stateOnDisk.current).toBe('PAUSED')
    expect(stateOnDisk.reason).toMatch(/reconcile error/)
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      payload: expect.objectContaining({ reason: 'reconcile error' }),
    }))
  })
})
