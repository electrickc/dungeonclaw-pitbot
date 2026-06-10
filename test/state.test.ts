import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BotStateManager, BotState } from '../src/state'

describe('BotStateManager', () => {
  let tmpDir: string
  let statePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'))
    statePath = path.join(tmpDir, 'state.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initializes in BOOT state', () => {
    const mgr = new BotStateManager(statePath)
    expect(mgr.current).toBe('BOOT')
  })

  it('persists state transitions to disk', () => {
    const mgr = new BotStateManager(statePath)
    mgr.transition('PENDING_SAFE_SETUP', { reason: 'no safe yet' })
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8')) as BotState
    expect(onDisk.current).toBe('PENDING_SAFE_SETUP')
  })

  it('restores from disk on reboot', () => {
    const mgr1 = new BotStateManager(statePath)
    mgr1.transition('PENDING_SAFE_SETUP', { reason: 'h' })
    mgr1.transition('RECONCILE', { reason: 'r' })
    mgr1.transition('OPERATIONAL', { lastRebalanceTs: 12345, currentCenter: 8388608 })
    const mgr2 = new BotStateManager(statePath)
    expect(mgr2.current).toBe('OPERATIONAL')
    expect(mgr2.snapshot.lastRebalanceTs).toBe(12345)
    expect(mgr2.snapshot.currentCenter).toBe(8388608)
  })

  it('rejects invalid transitions', () => {
    const mgr = new BotStateManager(statePath)
    expect(() => mgr.transition('OPERATIONAL', {})).toThrow(/invalid transition/)
  })
})
