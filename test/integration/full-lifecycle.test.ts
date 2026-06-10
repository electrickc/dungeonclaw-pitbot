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
})
