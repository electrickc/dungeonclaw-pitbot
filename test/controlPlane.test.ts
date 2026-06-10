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
})
