import { describe, it, expect, vi } from 'vitest'
import { withTimeout, RPCTimeoutError } from '../src/util/withTimeout'

describe('withTimeout', () => {
  it('resolves with the underlying value when the promise wins', async () => {
    const r = await withTimeout(Promise.resolve(42), 100, 'test')
    expect(r).toBe(42)
  })

  it('rejects with RPCTimeoutError when the timer wins', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50))
    await expect(withTimeout(slow, 10, 'slow-op')).rejects.toThrow(RPCTimeoutError)
  })

  it('error message includes the label and ms', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50))
    try {
      await withTimeout(slow, 10, 'snapshot')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(RPCTimeoutError)
      expect((e as Error).message).toContain('snapshot')
      expect((e as Error).message).toContain('10')
    }
  })

  it('clears the timer on success (no dangling handles)', async () => {
    const spy = vi.spyOn(global, 'clearTimeout')
    await withTimeout(Promise.resolve('ok'), 5000, 'fast')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('propagates a rejection from the underlying promise unchanged', async () => {
    const err = new Error('rpc revert')
    await expect(withTimeout(Promise.reject(err), 100, 'tokens')).rejects.toBe(err)
  })
})
