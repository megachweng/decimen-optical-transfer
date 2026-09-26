// One decode job — a full frame or a single-code crop — against the
// decimen-codec engine. Pure: the worker wraps it in message passing, and the
// tests drive it with the same wasm in Node.
//
// Two decode paths (see ../../decimen-codec/wrapper/decimen_codec.cpp):
//  - readFull: stock acquisition. QR-only, invert/rotate sweeps compiled off,
//    error results carry positions (the receiver's crop-seeding sightings).
//  - readTracked: crops that arrive with a cached quad + module count skip
//    detection entirely — the transform is rebuilt from the quad and the grid
//    is sampled directly. Bench-measured 2.0–2.6× per decode at V40.
//    Any tracked miss falls back to readFull on the same buffer, which also
//    re-anchors the quad. Tracked is opportunistic, never load-bearing.
//
// Clean-up (../shared/enhance.ts) wraps both. A full scan reads the capture
// as is, then at level 1, then — while codes are still missing — at level 2.
// A crop is read at its region's level and, when the receiver says so, one
// level up on a miss.

import type { DecimenModule, DecimenQuad } from "../vendor/decimen-codec/decimen_codec.js";
import { Enhancer, MAX_CLEAN_UP_LEVEL } from "../shared/enhance";
import type { SymbolBox, SymbolQuad } from "../shared/worker-pool";

export interface DecodeJob {
  /** Crop origin within the capture, for mapping positions back. */
  ox: number;
  oy: number;
  /** Full-frame scan (up to a 3×3 grid) vs a single-code crop. */
  full: boolean;
  /** The region's last decoded quad, capture coordinates — tracked path. */
  quad?: SymbolQuad;
  /** The stream's QR dimension in modules — tracked path. */
  dim?: number;
  /** Crop: the clean-up level to start at. */
  level?: number;
  /** Crop: on a miss, also try one level up. */
  escalate?: boolean;
  /** Full scan: how many codes the stream has recently shown at once. */
  expected?: number;
  /** Full scan: may run clean-up even when the raw pass found and saw
   *  nothing. The receiver rations this — with no codes in view the passes
   *  are wasted, and acquisition scans run at 10 Hz. */
  allowBlindCleanUp?: boolean;
  /** False turns clean-up off: the decode paths exactly as before it. */
  cleanUp?: boolean;
}

export interface DecodedSymbol {
  bytes: Uint8Array;
  box: SymbolBox;
  quad: SymbolQuad;
  modules: number;
  tracked: boolean;
  /** Clean-up level that read it; undefined for the raw full-scan pass. */
  level?: number;
}

export interface DecodeOutcome {
  symbols: DecodedSymbol[];
  /** Codes DETECTED but not decoded (full scans only). */
  sightings: SymbolBox[];
  trackedAttempted: boolean;
  /** Crop: every clean-up level tried, in order. */
  levelsTried: number[];
  /** Full scan: how many passes ran (1–3). */
  passes: number;
  /** Full scan: clean-up ran although the raw pass found and saw nothing. */
  blindCleanUp: boolean;
}

/** Scale a quad by (sx, sy) and shift it by (dx, dy). */
function mapQuad(p: DecimenQuad | SymbolQuad, sx: number, sy: number, dx: number, dy: number): SymbolQuad {
  const m = (pt: { x: number; y: number }) => ({ x: pt.x * sx + dx, y: pt.y * sy + dy });
  return { topLeft: m(p.topLeft), topRight: m(p.topRight), bottomRight: m(p.bottomRight), bottomLeft: m(p.bottomLeft) };
}

/** Axis-aligned bounds of a quad. */
function boundsOf(p: SymbolQuad): SymbolBox {
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Copy pixels into the wasm heap for the duration of `body`. */
function onHeap<T>(zx: DecimenModule, pixels: Uint8Array | Uint8ClampedArray, body: (ptr: number) => T): T {
  const ptr = zx._malloc(pixels.length);
  try {
    zx.HEAPU8.set(pixels, ptr);
    return body(ptr);
  } finally {
    zx._free(ptr);
  }
}

export function decodeJob(
  zx: DecimenModule,
  enhancer: Enhancer,
  pixels: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  job: DecodeJob,
): DecodeOutcome {
  const out: DecodeOutcome = { symbols: [], sightings: [], trackedAttempted: false, levelsTried: [], passes: 0, blindCleanUp: false };
  const cleanUp = job.cleanUp !== false;
  const { ox, oy } = job;
  // Levels share work within this job's buffer only.
  enhancer.reset();

  /** Pixels at a clean-up level, with the factors back to crop pixels. */
  const image = (level: number) => {
    if (level === 0) return { data: pixels, width: w, height: h, sx: 1, sy: 1 };
    return enhancer.process(pixels, w, h, level);
  };

  if (job.full) {
    const expected = job.expected ?? 0;
    for (let pass = 0; pass <= (cleanUp ? MAX_CLEAN_UP_LEVEL : 0); pass++) {
      if (pass === 1 && out.symbols.length === 0 && out.sightings.length === 0 && expected === 0) {
        if (!job.allowBlindCleanUp) break;
        out.blindCleanUp = true;
      }
      if (pass === MAX_CLEAN_UP_LEVEL) {
        // The costly pass only runs while something is missing: fewer codes
        // than the stream has shown, or a code detected where none decoded.
        const unexplained = out.sightings.some((s) => {
          const cx = s.x + s.w / 2;
          const cy = s.y + s.h / 2;
          return !out.symbols.some((f) => cx >= f.box.x && cx <= f.box.x + f.box.w && cy >= f.box.y && cy <= f.box.y + f.box.h);
        });
        if (out.symbols.length >= Math.max(1, expected) && !unexplained) break;
      }
      out.passes = pass + 1;
      const img = image(pass);
      onHeap(zx, img.data, (ptr) => {
        // Full scans get returnErrors (sightings live there — error results
        // COUNT against the symbol cap, hence the headroom above 9 codes).
        // tryHarder stays on everywhere: real marginal captures are where it
        // earns its keep.
        const vec = zx.readFull(ptr, img.width, img.height, true, 12, true);
        for (let i = 0; i < vec.size(); i++) {
          const r = vec.get(i);
          const quad = mapQuad(r.position, 1 / img.sx, 1 / img.sy, ox, oy);
          const box = boundsOf(quad);
          if (r.valid && r.bytes.length > 0) {
            if (out.symbols.some((s) => sameBytes(s.bytes, r.bytes))) continue;
            out.symbols.push({ bytes: r.bytes, box, quad, modules: r.modules, tracked: false, level: pass === 0 ? undefined : pass });
          } else if (box.w > 0 && box.h > 0) {
            // A symbol zxing DETECTED but could not decode (glare or noise
            // past the ECC budget) is still a fix on where a code sits — the
            // receiver aims a crop there, and crops decode where full frames
            // fail. Positions stay pixel-accurate through a ChecksumError.
            out.sightings.push(box);
          }
        }
        vec.delete();
      });
    }
    return out;
  }

  const start = job.level ?? 0;
  const top = cleanUp ? Math.min(job.escalate ? start + 1 : start, MAX_CLEAN_UP_LEVEL) : 0;
  for (let level = Math.min(start, top); level <= top; level++) {
    out.levelsTried.push(level);
    const img = image(level);
    onHeap(zx, img.data, (ptr) => {
      if (job.quad && job.dim) {
        out.trackedAttempted = true;
        const q = mapQuad(job.quad, img.sx, img.sy, -ox * img.sx, -oy * img.sy);
        const r = zx.readTracked(
          ptr, img.width, img.height, job.dim,
          q.topLeft.x, q.topLeft.y,
          q.topRight.x, q.topRight.y,
          q.bottomRight.x, q.bottomRight.y,
          q.bottomLeft.x, q.bottomLeft.y,
        );
        if (r.valid && r.bytes.length > 0) {
          const quad = mapQuad(r.position, 1 / img.sx, 1 / img.sy, ox, oy);
          out.symbols.push({ bytes: r.bytes, box: boundsOf(quad), quad, modules: r.modules, tracked: true, level });
          return;
        }
      }
      // A crop fallback stays in the cheapest configuration.
      const vec = zx.readFull(ptr, img.width, img.height, true, 2, false);
      for (let i = 0; i < vec.size(); i++) {
        const r = vec.get(i);
        if (!r.valid || r.bytes.length === 0) continue;
        const quad = mapQuad(r.position, 1 / img.sx, 1 / img.sy, ox, oy);
        out.symbols.push({ bytes: r.bytes, box: boundsOf(quad), quad, modules: r.modules, tracked: false, level });
      }
      vec.delete();
    });
    if (out.symbols.length > 0) break;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
