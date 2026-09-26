// QR decode worker: the decimen-codec engine (a custom zxing-cpp build)
// compiled to WASM. (Safari has
// never shipped BarcodeDetector — WebKit bug 281848 — so WASM is the only
// portable way.) One frame in flight per worker; the main thread drops frames
// when all workers are busy. Frames are disposable — the fountain doesn't care.
//
// The decode itself — the stock and tracked paths, and picture clean-up for
// poor captures — lives in ./decode.ts, where the tests can reach it.

import wasmUrl from "./wasm-url";
import DecimenCodec, { type DecimenModule } from "../vendor/decimen-codec/decimen_codec.js";
import { Enhancer } from "../shared/enhance";
import { decodeJob, type DecodeJob } from "./decode";

const ready: Promise<DecimenModule> = DecimenCodec({
  locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

/** Clean-up scratch buffers, one set per worker. */
const enhancer = new Enhancer();

// Reused for bitmap captures: the GPU-cropped ImageBitmap is drawn here and
// read back on THIS thread — the whole point of the bitmap path is that the
// main thread never touches pixels.
let offscreen: OffscreenCanvas | undefined;

/** Pixels from either capture mode: a transferred ArrayBuffer (readback
 *  fallback) or an ImageBitmap (GPU-side crop, Safari 17+/modern engines). */
function pixelsOf(buf: ArrayBuffer | undefined, bitmap: ImageBitmap | undefined, w: number, h: number) {
  if (bitmap) {
    const bw = bitmap.width;
    const bh = bitmap.height;
    if (!offscreen || offscreen.width !== bw || offscreen.height !== bh) {
      offscreen = new OffscreenCanvas(bw, bh);
    }
    const octx = offscreen.getContext("2d", { willReadFrequently: true })!;
    octx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = octx.getImageData(0, 0, bw, bh);
    return { data: img.data, w: bw, h: bh };
  }
  return { data: new Uint8Array(buf!), w, h };
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, bitmap, w = 0, h = 0, ...job } = e.data as DecodeJob & {
    id: number;
    /** Readback-fallback capture: raw RGBA. */
    buf?: ArrayBuffer;
    /** Bitmap capture: GPU-cropped, pixels read on this thread. */
    bitmap?: ImageBitmap;
    w?: number;
    h?: number;
  };
  const zx = await ready;
  const pixels = pixelsOf(buf, bitmap, w, h);
  try {
    const out = decodeJob(
      zx,
      enhancer,
      pixels.data instanceof Uint8Array ? pixels.data : new Uint8Array(pixels.data.buffer),
      pixels.w,
      pixels.h,
      { ...job, ox: job.ox ?? 0, oy: job.oy ?? 0, full: job.full ?? true },
    );
    ctx.postMessage({ id, ...out });
  } catch {
    ctx.postMessage({ id, symbols: [], sightings: [] });
  }
};

// Warm the WASM (instantiation + first-call JIT) so the first real frame
// doesn't pay for it; the pool ignores the {id: -1} ping.
void (async () => {
  try {
    const zx = await ready;
    const ptr = zx._malloc(8 * 8 * 4);
    zx.HEAPU8.set(new Uint8Array(8 * 8 * 4).fill(255), ptr);
    zx.readFull(ptr, 8, 8, false, 1, false).delete();
    zx._free(ptr);
  } catch {
    // a failed warm-up is a slow first frame, not an error
  }
  ctx.postMessage({ id: -1, bytes: null });
})();
