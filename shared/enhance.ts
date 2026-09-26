// Picture clean-up for poor captures, ahead of the decoder.
//
// A 4- or 6-code grid leaves each code a small patch of the camera frame:
// a V40 code in a 2×3 grid on a 1440-line camera gets 2–2.4 px per module,
// and a little defocus (Gaussian σ ≈ 0.8 px) is then enough for the stock
// decode path to read nothing at all. Resampling to more pixels per module
// and an unsharp mask to restore the edge contrast that defocus took away
// buy back most of it. The output is gray RGBA, which is all the decoder reads.
//
// Three levels, each roughly twice the cost of the one before, so the
// receiver climbs only when a level stops decoding:
//   0 — the capture as is
//   1 — unsharp mask, amount 3, σ 1 px
//   2 — level 1, then a 1.5× Lanczos-3 resample
// The macOS receiver (Enhance.swift there) sharpens level 2 after the
// resample (σ 1.5 output px); sharpening first is the same filter to within
// the resampler's own blur, reads the same codes on the same frames
// (Scripts/degraded-web.mts in the macOS repo), and costs half: level 2 then
// reuses level 1's work when a crop climbs from one to the other. Level 1
// moves the defocus a V40 code survives from σ ≈ 0.8 to 1.0 px, level 2 to
// 1.1–1.3 px.

export const MAX_CLEAN_UP_LEVEL = 2;

export interface CleanUpParams {
  scale: number;
  amount: number;
  sigma: number;
}

export function cleanUpParams(level: number): CleanUpParams {
  switch (level) {
    case 1:
      return { scale: 1, amount: 3, sigma: 1 };
    case 2:
      return { scale: 1.5, amount: 3, sigma: 1 };
    default:
      return { scale: 1, amount: 0, sigma: 0 };
  }
}

export interface CleanedImage {
  /** Gray RGBA, tightly packed. Owned by the Enhancer: valid until its next call. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Output pixels per input pixel along each axis — maps quads in and out. */
  sx: number;
  sy: number;
}

/** Growable scratch buffer: one allocation per worker, not per frame. */
class Scratch {
  private buf = new Float32Array(0);
  get(n: number): Float32Array {
    if (this.buf.length < n) this.buf = new Float32Array(Math.ceil(n * 1.25));
    return this.buf.subarray(0, n);
  }
}

function lanczos3(x: number): number {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** Per tap (6), per output index: the clamped source index and its normalised
 *  weight, laid out tap-major so each tap is one straight pass. */
interface Taps {
  index: Int32Array;
  weights: Float32Array;
}

function resampleTaps(inSize: number, outSize: number, scale: number): Taps {
  const index = new Int32Array(outSize * 6);
  const weights = new Float32Array(outSize * 6);
  for (let i = 0; i < outSize; i++) {
    const centre = (i + 0.5) / scale - 0.5;
    const first = Math.floor(centre) - 2;
    let sum = 0;
    for (let t = 0; t < 6; t++) sum += lanczos3(centre - (first + t));
    for (let t = 0; t < 6; t++) {
      const src = first + t;
      index[t * outSize + i] = src < 0 ? 0 : src >= inSize ? inSize - 1 : src;
      weights[t * outSize + i] = lanczos3(centre - src) / sum;
    }
  }
  return { index, weights };
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

export class Enhancer {
  private readonly lum = new Scratch();
  private readonly mid = new Scratch();
  private readonly plane = new Scratch();
  private readonly blurred = new Scratch();
  private out = new Uint32Array(0);
  /** The last sharpened plane and the pixels it came from, for a crop that
   *  climbs from level 1 to level 2 on the same buffer. */
  private sharpOf: { src: Uint8Array | Uint8ClampedArray; width: number; height: number; amount: number; sigma: number } | null = null;
  private readonly taps = new Map<string, Taps>();
  private readonly kernels = new Map<number, Float32Array>();

  process(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, level: number): CleanedImage {
    const { scale, amount, sigma } = cleanUpParams(level);
    const ow = Math.max(1, Math.round(width * scale));
    const oh = Math.max(1, Math.round(height * scale));

    // Sharpen at capture resolution, then resample.
    let plane = this.lum.get(width * height);
    const sharp = this.sharpOf;
    const reuse = sharp !== null && sharp.src === rgba && sharp.width === width && sharp.height === height &&
      sharp.amount === amount && sharp.sigma === sigma;
    if (!reuse) {
      // Rec. 601 luma with zxing's integer weights (RGBToLum).
      for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
        plane[i] = (306 * rgba[p]! + 601 * rgba[p + 1]! + 117 * rgba[p + 2]!) / 1024;
      }
      if (amount > 0) this.unsharp(plane, width, height, amount, sigma);
      this.sharpOf = { src: rgba, width, height, amount, sigma };
    }
    if (scale !== 1) plane = this.resample(plane, width, height, ow, oh, scale);

    // Clamp, round, replicate: one little-endian RGBA word per pixel.
    const n = ow * oh;
    if (this.out.length < n) this.out = new Uint32Array(n);
    const out = this.out.subarray(0, n);
    for (let i = 0; i < n; i++) {
      const v = plane[i]!;
      const g = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
      out[i] = 0xff000000 | (g << 16) | (g << 8) | g;
    }
    // Output pixel x samples input (x + ½)/scale − ½: positions map by exactly `scale`.
    return { data: new Uint8Array(out.buffer, out.byteOffset, n * 4), width: ow, height: oh, sx: scale, sy: scale };
  }

  /** Forget the cached sharpened plane (the source buffer is about to be reused). */
  reset(): void {
    this.sharpOf = null;
  }

  private tapsFor(inSize: number, outSize: number, scale: number) {
    const key = `${inSize}>${outSize}@${scale}`;
    let t = this.taps.get(key);
    if (!t) {
      if (this.taps.size > 64) this.taps.clear();
      t = resampleTaps(inSize, outSize, scale);
      this.taps.set(key, t);
    }
    return t;
  }

  /** Separable Lanczos-3: rows into `mid` (h × ow), then columns into `plane`. */
  private resample(src: Float32Array, w: number, h: number, ow: number, oh: number, scale: number): Float32Array {
    const tx = this.tapsFor(w, ow, scale);
    const ty = this.tapsFor(h, oh, scale);
    const mid = this.mid.get(ow * h);
    const { index: xi, weights: xw } = tx;
    // At 1.5× the taps repeat every three outputs (two inputs): the interior
    // runs on constant weights, the edges on the clamped tables.
    let lo = ow, hi = ow;
    if (scale === 1.5) {
      lo = 3 * 2; // outputs 0…5 may reach below input 0
      hi = Math.max(lo, 3 * Math.floor((w - 4) / 2));
    }
    const general = (row: number, dst: number, x: number) => {
      mid[dst + x] =
        xw[x]! * src[row + xi[x]!]! + xw[ow + x]! * src[row + xi[ow + x]!]! +
        xw[2 * ow + x]! * src[row + xi[2 * ow + x]!]! + xw[3 * ow + x]! * src[row + xi[3 * ow + x]!]! +
        xw[4 * ow + x]! * src[row + xi[4 * ow + x]!]! + xw[5 * ow + x]! * src[row + xi[5 * ow + x]!]!;
    };
    // Phase m of the three: its six weights and first tap relative to 2j.
    const wt = (m: number, t: number) => xw[t * ow + lo + m]!;
    const a0 = wt(0, 0), a1 = wt(0, 1), a2 = wt(0, 2), a3 = wt(0, 3), a4 = wt(0, 4), a5 = wt(0, 5);
    const b0 = wt(1, 0), b1 = wt(1, 1), b2 = wt(1, 2), b3 = wt(1, 3), b4 = wt(1, 4), b5 = wt(1, 5);
    const c0 = wt(2, 0), c1 = wt(2, 1), c2 = wt(2, 2), c3 = wt(2, 3), c4 = wt(2, 4), c5 = wt(2, 5);
    const fa = xi[lo]! - 2 * (lo / 3), fb = xi[lo + 1]! - 2 * (lo / 3), fc = xi[lo + 2]! - 2 * (lo / 3);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const dst = y * ow;
      for (let x = 0; x < lo && x < ow; x++) general(row, dst, x);
      for (let x = lo; x < hi; x += 3) {
        const j2 = row + 2 * (x / 3);
        const pa = j2 + fa, pb = j2 + fb, pc = j2 + fc;
        mid[dst + x] = a0 * src[pa]! + a1 * src[pa + 1]! + a2 * src[pa + 2]! + a3 * src[pa + 3]! + a4 * src[pa + 4]! + a5 * src[pa + 5]!;
        mid[dst + x + 1] = b0 * src[pb]! + b1 * src[pb + 1]! + b2 * src[pb + 2]! + b3 * src[pb + 3]! + b4 * src[pb + 4]! + b5 * src[pb + 5]!;
        mid[dst + x + 2] = c0 * src[pc]! + c1 * src[pc + 1]! + c2 * src[pc + 2]! + c3 * src[pc + 3]! + c4 * src[pc + 4]! + c5 * src[pc + 5]!;
      }
      for (let x = hi; x < ow; x++) general(row, dst, x);
    }
    const out = this.plane.get(ow * oh);
    for (let y = 0; y < oh; y++) {
      const base = y * ow;
      const r0 = ty.index[y]! * ow, r1 = ty.index[oh + y]! * ow, r2 = ty.index[2 * oh + y]! * ow;
      const r3 = ty.index[3 * oh + y]! * ow, r4 = ty.index[4 * oh + y]! * ow, r5 = ty.index[5 * oh + y]! * ow;
      const w0 = ty.weights[y]!, w1 = ty.weights[oh + y]!, w2 = ty.weights[2 * oh + y]!;
      const w3 = ty.weights[3 * oh + y]!, w4 = ty.weights[4 * oh + y]!, w5 = ty.weights[5 * oh + y]!;
      for (let x = 0; x < ow; x++) {
        out[base + x] =
          w0 * mid[r0 + x]! + w1 * mid[r1 + x]! + w2 * mid[r2 + x]! +
          w3 * mid[r3 + x]! + w4 * mid[r4 + x]! + w5 * mid[r5 + x]!;
      }
    }
    return out;
  }

  /** In place: plane + amount·(plane − gaussian(plane)), edges extended. */
  private unsharp(plane: Float32Array, w: number, h: number, amount: number, sigma: number): void {
    let k = this.kernels.get(sigma);
    if (!k) {
      k = gaussianKernel(sigma);
      this.kernels.set(sigma, k);
    }
    const tmp = this.mid.get(w * h);
    const blurred = this.blurred.get(w * h);
    blurRows(plane, tmp, w, h, k);
    blurColumns(tmp, blurred, w, h, k);
    for (let i = 0; i < w * h; i++) plane[i] = plane[i]! + amount * (plane[i]! - blurred[i]!);
  }
}

// Symmetric separable blur. Each output pixel is written once, summing the
// mirrored tap pairs — a straight loop the JIT keeps tight. Edges extend.

function blurRows(src: Float32Array, dst: Float32Array, w: number, h: number, k: Float32Array): void {
  const r = (k.length - 1) / 2;
  const edge = (row: number, x: number) => {
    let acc = 0;
    for (let i = -r; i <= r; i++) {
      const xi = x + i;
      acc += k[i + r]! * src[row + (xi < 0 ? 0 : xi >= w ? w - 1 : xi)]!;
    }
    dst[row + x] = acc;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < Math.min(r, w); x++) edge(row, x);
    if (r === 3) {
      const k0 = k[3]!, k1 = k[4]!, k2 = k[5]!, k3 = k[6]!;
      for (let c = row + 3, e = row + w - 3; c < e; c++) {
        dst[c] = k0 * src[c]! + k1 * (src[c - 1]! + src[c + 1]!) + k2 * (src[c - 2]! + src[c + 2]!) + k3 * (src[c - 3]! + src[c + 3]!);
      }
    } else {
      for (let c = row + r, e = row + w - r; c < e; c++) {
        let acc = k[r]! * src[c]!;
        for (let i = 1; i <= r; i++) acc += k[r + i]! * (src[c - i]! + src[c + i]!);
        dst[c] = acc;
      }
    }
    for (let x = Math.max(r, w - r); x < w; x++) edge(row, x);
  }
}

function blurColumns(src: Float32Array, dst: Float32Array, w: number, h: number, k: Float32Array): void {
  const r = (k.length - 1) / 2;
  const clampRow = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    if (r === 3 && y >= 3 && y < h - 3) {
      const k0 = k[3]!, k1 = k[4]!, k2 = k[5]!, k3 = k[6]!;
      const w2 = 2 * w, w3 = 3 * w;
      for (let c = base, e = base + w; c < e; c++) {
        dst[c] = k0 * src[c]! + k1 * (src[c - w]! + src[c + w]!) + k2 * (src[c - w2]! + src[c + w2]!) + k3 * (src[c - w3]! + src[c + w3]!);
      }
      continue;
    }
    const k0 = k[r]!;
    for (let x = 0; x < w; x++) dst[base + x] = k0 * src[base + x]!;
    for (let i = 1; i <= r; i++) {
      const up = clampRow(y - i), down = clampRow(y + i);
      const ki = k[r + i]!;
      for (let x = 0; x < w; x++) dst[base + x]! += ki * (src[up + x]! + src[down + x]!);
    }
  }
}
