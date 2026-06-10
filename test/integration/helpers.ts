import { spawn, ChildProcess } from 'child_process'
import { ethers } from 'ethers'
import express from 'express'
import type { Server } from 'http'

export interface AnvilHandle {
  process: ChildProcess
  rpcUrl: string
  kill: () => void
}

/** Spawn anvil forked from Base mainnet at a fixed block. */
export async function startAnvil(forkBlock = 46041000): Promise<AnvilHandle> {
  const proc = spawn('anvil', [
    '--fork-url', 'https://mainnet.base.org',
    '--fork-block-number', String(forkBlock),
    '--port', '8546',
    '--silent',
  ])

  // Wait for anvil to start accepting connections
  const rpcUrl = 'http://localhost:8546'
  for (let i = 0; i < 30; i++) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl)
      await provider.getBlockNumber()
      return {
        process: proc,
        rpcUrl,
        kill: () => proc.kill(),
      }
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('anvil failed to start')
}

export interface MockControlPlane {
  server: Server
  baseUrl: string
  setSync: (s: any) => void
  events: any[]
  kill: () => void
}

/** Tiny in-process mock control plane. */
export async function startMockControlPlane(): Promise<MockControlPlane> {
  let currentSync: any = {
    status: 'pending_safe_setup',
    safeAddress: null,
    helperAddress: null,
    pairAddress: null,
    strategy: null,
    rebalanceCooldownSeconds: 0,
    syncPollIntervalSeconds: 1,
    chainPollIntervalSeconds: 1,
    killSwitch: false,
    consecutiveSyncFailureThreshold: 3,
  }
  const events: any[] = []
  const app = express()
  app.use(express.json())
  app.post('/pools/:poolId/handshake', (_req, res) => res.json({ ok: true }))
  app.get('/pools/:poolId/sync', (_req, res) => res.json(currentSync))
  app.post('/pools/:poolId/events', (req, res) => {
    events.push(req.body)
    res.json({ ok: true })
  })
  const server = app.listen(0)
  const port = (server.address() as any).port
  return {
    server,
    baseUrl: `http://localhost:${port}`,
    setSync: (s) => Object.assign(currentSync, s),
    events,
    kill: () => server.close(),
  }
}
