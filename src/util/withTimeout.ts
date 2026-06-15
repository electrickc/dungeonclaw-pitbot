export class RPCTimeoutError extends Error {
  constructor(public readonly label: string, public readonly ms: number) {
    super(`RPC timeout (${ms}ms) on ${label}`)
    this.name = 'RPCTimeoutError'
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RPCTimeoutError(label, ms)), ms)
  })
  try {
    return await Promise.race([p, timeoutP])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
