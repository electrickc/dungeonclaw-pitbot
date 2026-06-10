import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { ControlPlaneClient } from '../src/controlPlane'

describe('ControlPlaneClient', () => {
  let server: Server
  let app: express.Express
  let received: { handshake?: any } = {}

  beforeEach(async () => {
    received = {}
    app = express()
    app.use(express.json())
    app.post('/pools/:poolId/handshake', (req, res) => {
      received.handshake = { poolId: req.params.poolId, body: req.body }
      res.status(200).json({ ok: true })
    })
    server = app.listen(0)
  })

  afterEach(() => {
    server.close()
  })

  it('sends handshake with bot address', async () => {
    const port = (server.address() as any).port
    const client = new ControlPlaneClient({
      baseUrl: `http://localhost:${port}`,
      token: 'test-token',
      poolId: 'pool-xyz',
    })
    await client.handshake('0xABCDEF0000000000000000000000000000000001')
    expect(received.handshake?.poolId).toBe('pool-xyz')
    expect(received.handshake?.body.botAddress).toBe('0xABCDEF0000000000000000000000000000000001')
  })

  it('reads sync response', async () => {
    const port = (server.address() as any).port
    app.get('/pools/:poolId/sync', (_req, res) => {
      res.json({
        status: 'pending_safe_setup',
        safeAddress: null,
        helperAddress: null,
        pairAddress: null,
        strategy: null,
        rebalanceCooldownSeconds: 60,
        syncPollIntervalSeconds: 30,
        chainPollIntervalSeconds: 15,
        killSwitch: false,
        consecutiveSyncFailureThreshold: 5,
      })
    })
    const client = new ControlPlaneClient({
      baseUrl: `http://localhost:${port}`,
      token: 'test',
      poolId: 'pool-xyz',
    })
    const sync = await client.sync()
    expect(sync.status).toBe('pending_safe_setup')
    expect(sync.safeAddress).toBeNull()
  })

  it('throws on 5xx sync error', async () => {
    const port = (server.address() as any).port
    app.get('/pools/:poolId/sync', (_req, res) => { res.status(500).send('boom') })
    const client = new ControlPlaneClient({
      baseUrl: `http://localhost:${port}`,
      token: 'test',
      poolId: 'pool-xyz',
    })
    await expect(client.sync()).rejects.toThrow(/sync failed: 500/)
  })
})
