// Fixed-slot pool of decode workers.
//
// The subtle part is slot identity: every worker's message handler closes over
// its own index, so growing and shrinking the pool has to leave the surviving
// workers' indices alone. Shrinking from the end is what makes that true, and
// it is why this is worth having on its own rather than inline in the receiver.
//
// Each worker holds its own ~940 KB zxing WASM instance, so the pool is also
// how the receiver reclaims that memory the moment the last frame is in.

export interface PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

/** Where a symbol sat in the capture, in capture coordinates. */
export interface SymbolBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A symbol's corner quad in capture coordinates — the tracked decode path
 *  rebuilds its sampling transform from this, so unlike the axis-aligned box
 *  it must survive the round trip un-flattened. */
export interface SymbolQuad {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}

/** Decode metadata that rides along with the bytes. */
export interface SymbolInfo {
  quad?: SymbolQuad;
  /** QR dimension in modules; feeds the next tracked decode. */
  modules?: number;
  /** True when the tracked fast path produced this decode. */
  tracked?: boolean;
  /** Clean-up level that read it (../shared/enhance.ts); undefined for the
   *  raw full-scan pass. */
  level?: number;
}

/** What one decode job cost, for the diagnostics report. */
export interface DecodeReport {
  /** Crop: the clean-up levels it tried, in order. */
  levelsTried?: number[];
  /** Full scan: how many clean-up passes ran (1–3). */
  passes?: number;
  /** Full scan: clean-up ran although the raw pass found and saw nothing. */
  blindCleanUp?: boolean;
}

interface DecodeMessage {
  id: number;
  /** Every QR found in the frame. The grid sender shows several codes at
   *  once; each one is an independent fountain frame. Empty means a miss. */
  symbols: { bytes: Uint8Array; box?: SymbolBox; quad?: SymbolQuad; modules?: number; tracked?: boolean; level?: number }[];
  /** Codes DETECTED but not decoded — no bytes, but the position is real.
   *  The receiver uses these to aim crops at codes the full frame lost. */
  sightings?: SymbolBox[];
  /** True when this reply's crop went through the tracked fast path first —
   *  paired with per-symbol `tracked`, the receiver derives the hit rate. */
  trackedAttempted?: boolean;
}

export class DecodeWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly busy: boolean[] = [];

  constructor(
    private readonly create: () => PoolWorker,
    private readonly onDecoded: (bytes: Uint8Array, box?: SymbolBox, info?: SymbolInfo) => void,
    private readonly onSighted?: (box: SymbolBox) => void,
    private readonly onTrackedAttempt?: () => void,
    private readonly onReport?: (report: DecodeReport) => void,
  ) {}

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.busy.filter(Boolean).length;
  }

  /** Grow or shrink in place. Terminating a busy worker just drops the frame it
   *  held, which the fountain absorbs like any other miss. */
  resize(count: number): void {
    while (this.workers.length > Math.max(0, count)) {
      this.workers.pop()!.terminate();
      this.busy.pop();
    }
    while (this.workers.length < count) {
      const slot = this.workers.length;
      const worker = this.create();
      worker.onmessage = (event: MessageEvent) => {
        const { id, symbols, sightings, trackedAttempted, ...report } = event.data as DecodeMessage & DecodeReport;
        if (id === -1) return; // warm-up ping, no frame attached
        this.busy[slot] = false;
        if (trackedAttempted) this.onTrackedAttempt?.();
        for (const s of symbols)
          this.onDecoded(s.bytes, s.box, {
            quad: s.quad,
            modules: s.modules,
            tracked: s.tracked,
            ...(s.level !== undefined ? { level: s.level } : {}),
          });
        if (this.onSighted) for (const box of sightings ?? []) this.onSighted(box);
        this.onReport?.(report);
      };
      this.workers.push(worker);
      this.busy.push(false);
    }
  }

  /** Hand a frame to a free worker. False when every worker is busy — the
   *  caller drops the frame rather than queueing it, because a stale frame is
   *  worth less than the next one. */
  submit(message: unknown, transfer: Transferable[]): boolean {
    const slot = this.busy.indexOf(false);
    if (slot === -1) return false;
    this.busy[slot] = true;
    this.workers[slot]!.postMessage(message, transfer);
    return true;
  }
}
