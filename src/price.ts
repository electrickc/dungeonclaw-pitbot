// Ring buffer of recent active-bin samples for detecting "big green candle" spikes.
// We don't need an oracle — the active bin IS the price in DLMM terms, and
// (active - prior) over a known time delta = candle direction + magnitude.

interface Sample {
  ts: number // unix seconds
  activeId: number
}

const HISTORY_MAX = 60 // ~15 minutes at 15s polling

export class PriceTracker {
  private samples: Sample[] = []

  push(activeId: number, ts = Math.floor(Date.now() / 1000)): void {
    this.samples.push({ ts, activeId })
    if (this.samples.length > HISTORY_MAX) this.samples.shift()
  }

  latest(): Sample | undefined {
    return this.samples[this.samples.length - 1]
  }

  // Bins moved up in the last `windowSeconds`. Positive = price spiked up.
  // Returns 0 if we don't have enough history yet.
  binDeltaOver(windowSeconds: number): number {
    if (this.samples.length < 2) return 0
    const now = this.samples[this.samples.length - 1]
    const cutoff = now.ts - windowSeconds
    // Find the oldest sample within the window
    const earliest = this.samples.find((s) => s.ts >= cutoff)
    if (!earliest || earliest === now) return 0
    return now.activeId - earliest.activeId
  }

  reset(): void {
    this.samples = []
  }
}
