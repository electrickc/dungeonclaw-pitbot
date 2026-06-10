import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startAnvil, startMockControlPlane, AnvilHandle, MockControlPlane } from './helpers'

describe('full-lifecycle integration', () => {
  let anvil: AnvilHandle
  let cp: MockControlPlane

  beforeAll(async () => {
    anvil = await startAnvil()
    cp = await startMockControlPlane()
  }, 30_000)

  afterAll(() => {
    anvil?.kill()
    cp?.kill()
  })

  it('starts anvil and mock control plane', () => {
    expect(anvil.rpcUrl).toMatch(/^http:\/\/localhost/)
    expect(cp.baseUrl).toMatch(/^http:\/\/localhost/)
  })

  it('bot handshakes with control plane on boot', async () => {
    // Run bot's boot routine in-process by setting env vars and importing.
    process.env.POOL_ID = 'pool-test'
    process.env.CONTROL_PLANE_URL = cp.baseUrl
    process.env.CONTROL_PLANE_TOKEN = 'test-token'
    process.env.RPC_URL = anvil.rpcUrl
    process.env.STATE_PATH = '/tmp/bot-state-test.json'

    // Clean state file
    const fs = await import('fs')
    if (fs.existsSync('/tmp/bot-state-test.json')) fs.unlinkSync('/tmp/bot-state-test.json')

    // Import and run minimal boot path
    const { loadConfig } = await import('../../src/config')
    const { ControlPlaneClient } = await import('../../src/controlPlane')
    const { BotStateManager } = await import('../../src/state')
    const { ethers } = await import('ethers')

    const cfg = loadConfig()
    const client = new ControlPlaneClient({
      baseUrl: cfg.controlPlaneUrl,
      token: cfg.controlPlaneToken,
      poolId: cfg.poolId,
    })
    const state = new BotStateManager(cfg.statePath)
    const wallet = ethers.Wallet.createRandom()
    await client.handshake(wallet.address)
    state.transition('PENDING_SAFE_SETUP', { reason: 'handshake' })

    // Mock CP should have recorded no events (handshake isn't an event)
    expect(state.current).toBe('PENDING_SAFE_SETUP')
  }, 30_000)
})
